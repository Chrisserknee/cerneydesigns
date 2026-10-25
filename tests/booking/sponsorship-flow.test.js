'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers/sponsorship-fixture.cjs');
const {dispatchOutbox}=require('../../functions-booking/sponsorship-outbox');
const token='a'.repeat(64);
const rejectsCode=(promise,code)=>assert.rejects(promise,e=>e.code===code);

test('request → approval → signature → invoice → payment → confirmed calendar',async()=>{
    const h=createHarness(),w=h.workflow;
    const first=await h.submit();assert.equal(first.status,'pending');assert.deepEqual(await h.submit(),first);
    let s=await h.store.read();assert.equal(Object.keys(s.orders).length,1);assert.equal(Object.keys(s.outbox).length,2);assert.equal(s.orders[first.id].signature,undefined);assert.equal(h.events.size,0);
    await rejectsCode(w.handle({op:'checkout',id:first.id,token}),409);
    await rejectsCode(w.handle({op:'status',id:first.id,token:'b'.repeat(64)}),404);
    const approved=await w.handle({op:'approve',id:first.id});assert.equal(approved.status,'approved');assert.equal(h.events.size,1);
    assert.equal((await w.handle({op:'availability',date:'2026-10-20'})).slots.some(s=>s.start===approved.slot.start),false);
    await rejectsCode(w.handle({op:'checkout',id:first.id,token}),409);
    await rejectsCode(w.handle({op:'sign',id:first.id,token,agreementHash:'tampered',signerName:'Test',signerTitle:'Owner',authorized:true,electronicConsent:true}),409);
    await h.sign(first.id);
    const [a,b]=await Promise.all([w.handle({op:'checkout',id:first.id,token}),w.handle({op:'checkout',id:first.id,token})]);assert.equal(a.url,b.url);assert.equal(h.metrics.issues,1);
    const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=invoice.total;
    await w.paymentReceived(invoice);await w.paymentReceived(invoice);
    const paid=await w.handle({op:'status',id:first.id,token});assert.equal(paid.status,'paid');assert.equal(paid.calendarConfirmed,true);assert.equal(h.metrics.confirmations,1);
    s=await h.store.read();assert.equal(Object.keys(s.outbox).length,5);assert.equal(s.outbox[first.id+'-request-owner'].text.includes('Synthetic business'),true);
    assert.equal(s.outbox[first.id+'-approved-client'].text.includes('token='+token),true);
    assert.equal(JSON.stringify(await w.handle({op:'list'})).includes(token),false);
});

test('competing requests can be submitted, but only one overlapping shoot is accepted',async()=>{
    const h=createHarness(),a=await h.submit(),b=await h.submit('b'.repeat(64));
    const results=await Promise.allSettled([h.workflow.handle({op:'approve',id:a.id}),h.workflow.handle({op:'approve',id:b.id})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Object.keys((await h.store.read()).holds).length,1);assert.equal(h.events.size,1);
});

test('live Google conflict prevents acceptance without creating a hold or invoice',async()=>{
    const h=createHarness(),{id}=await h.submit();h.calendar.external=[{start:Date.parse('2026-10-20T16:00Z'),end:Date.parse('2026-10-20T17:00Z')}];
    await rejectsCode(h.workflow.handle({op:'approve',id}),409);assert.equal((await h.store.read()).orders[id].status,'pending');assert.equal(h.events.size,0);assert.equal(h.invoices.size,0);
});

test('new calendar conflict blocks an existing unpaid invoice link',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    h.calendar.external=[{start:Date.parse('2026-10-20T16:00Z'),end:Date.parse('2026-10-20T17:00Z')}];
    await rejectsCode(h.workflow.handle({op:'checkout',id,token}),409);assert.equal(h.metrics.issues,1);
});

test('changed Stripe totals do not release a payment link',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    [...h.invoices.values()][0].total=1;await rejectsCode(h.workflow.handle({op:'checkout',id,token}),409);
});

test('a copied invoice cannot be used for a different Stripe customer',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    await h.store.change(s=>{s.orders[id].stripeCustomerId='cus_expected';});
    [...h.invoices.values()][0].customer='cus_other';
    await assert.rejects(h.workflow.handle({op:'checkout',id,token}),/Invoice customer needs review/);
});

test('an existing unpaid recurring link is rechecked against the current Stripe plan',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    await h.store.change(s=>{s.orders[id].package.billing='three_month';});
    let verified=0;h.payments.verifyInitialPlan=async()=>{verified++;throw Object.assign(new Error('The billing plan changed.'),{code:409});};
    await assert.rejects(h.workflow.handle({op:'checkout',id,token}),/billing plan changed/);
    assert.equal(verified,1);assert.equal(h.metrics.issues,1);
});

test('calendar outage fails closed and interrupted approval can recover',async()=>{
    const h=createHarness(),{id}=await h.submit(),original=h.calendar.hold;
    h.calendar.failure=Object.assign(new Error('Offline'),{code:503});await rejectsCode(h.workflow.handle({op:'availability',date:'2026-10-20'}),503);h.calendar.failure=null;
    h.calendar.hold=async()=>{throw Object.assign(new Error('Lost response'),{code:503});};
    await rejectsCode(h.workflow.handle({op:'approve',id}),503);assert.equal((await h.store.read()).orders[id].status,'accepting');assert.equal(Object.keys((await h.store.read()).holds).length,1);
    h.calendar.hold=original;await h.workflow.reconcile();assert.equal((await h.store.read()).orders[id].status,'approved');
});

test('paid status survives a calendar failure and retry sends one confirmation',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=invoice.total;h.calendar.confirmFailure=true;
    await rejectsCode(h.workflow.paymentReceived(invoice),503);let s=await h.store.read();assert.equal(s.orders[id].status,'paid');assert.equal(s.orders[id].calendarConfirmed,false);assert.ok(s.outbox[id+'-calendar-review-owner']);assert.equal(s.outbox[id+'-paid-client'],undefined);
    h.calendar.confirmFailure=false;await h.workflow.reconcile();s=await h.store.read();assert.equal(s.orders[id].calendarConfirmed,true);assert.ok(s.outbox[id+'-paid-client']);assert.equal(h.metrics.issues,1);
});

test('scheduled recovery confirms a paid invoice after a missed webhook without charging again',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=invoice.total;
    await h.workflow.reconcile();await h.workflow.reconcile();
    const state=await h.store.read();assert.equal(state.orders[id].status,'paid');assert.equal(state.orders[id].calendarConfirmed,true);
    assert.equal(h.metrics.issues,1);assert.equal(h.metrics.confirmations,1);assert.ok(state.outbox[id+'-paid-client']);
});

test('recovery preserves a paid booking after calendar failure and clears its warning after repair',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=invoice.total;h.calendar.confirmFailure=true;
    await h.workflow.reconcile();let state=await h.store.read();
    assert.equal(state.orders[id].status,'paid');assert.ok(state.orders[id].reconciliationIssue);assert.equal(state.outbox[id+'-paid-client'],undefined);
    h.calendar.confirmFailure=false;await h.workflow.reconcile();state=await h.store.read();
    assert.equal(state.orders[id].calendarConfirmed,true);assert.equal(state.orders[id].reconciliationIssue,undefined);assert.ok(state.outbox[id+'-paid-client']);
});

test('a paid event arriving before checkout saves the pinned invoice reference is recoverable',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=invoice.total;
    await h.store.change(s=>{const r=s.orders[id];r.stripeInitialInvoiceId=r.invoice.id;delete r.invoice;});
    await h.workflow.reconcile();const state=await h.store.read();
    assert.equal(state.orders[id].invoice.id,invoice.id);assert.equal(state.orders[id].calendarConfirmed,true);
});

test('recovery rejects an invoice for the wrong Stripe customer and never exposes provider errors',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    await h.store.change(s=>{s.orders[id].stripeCustomerId='cus_expected';});
    const invoice=[...h.invoices.values()][0];Object.assign(invoice,{status:'paid',amount_paid:invoice.total,customer:'cus_other'});
    await h.workflow.reconcile();let state=await h.store.read();assert.equal(state.orders[id].status,'signed');assert.ok(state.orders[id].reconciliationIssue);assert.equal(h.metrics.confirmations,0);
    h.payments.retrieve=async()=>{throw Error('private provider response contents');};await h.workflow.reconcile();
    state=await h.store.read();assert.ok(!JSON.stringify(state).includes('private provider response contents'));
});

test('an unpaid batch cannot starve a later paid booking from scheduled recovery',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const original=(await h.store.read()).orders[id],invoice=[...h.invoices.values()][0];let last;
    await h.store.change(s=>{
        s.orders={};
        for(let i=0;i<25;i++){
            const key=i.toString(16).padStart(32,'0'),invoiceId='in_'+key;last=key;
            s.orders[key]={...structuredClone(original),id:key,invoice:{id:invoiceId}};h.events.set(key,original.slot);
            h.invoices.set(invoiceId,{...structuredClone(invoice),id:invoiceId,metadata:{...invoice.metadata,sponsorshipId:key},status:i===24?'paid':'open',amount_paid:i===24?invoice.total:0});
        }
    });
    await h.workflow.reconcile();assert.equal((await h.store.read()).orders[last].status,'signed');
    await h.workflow.reconcile();assert.equal((await h.store.read()).orders[last].status,'paid');assert.equal(h.metrics.issues,1);
});

test('repeated recovery failures queue one owner alert and never misstate payment',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    [...h.invoices.values()][0].status='void';
    await h.workflow.reconcile();await h.workflow.reconcile();assert.equal((await h.store.read()).outbox[id+'-recovery-review-owner'],undefined);
    await h.workflow.reconcile();await h.workflow.reconcile();const state=await h.store.read(),job=state.outbox[id+'-recovery-review-owner'];
    assert.equal(job.to,'cerneymedia@gmail.com');assert.match(job.text,/does not confirm that payment was received/);
    assert.equal(Object.values(state.outbox).filter(j=>j.type==='recovery-review-owner').length,1);assert.equal(state.orders[id].status,'signed');
});

test('reconciliation never applies an invoice belonging to a different booking',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token});
    const invoice=[...h.invoices.values()][0];Object.assign(invoice,{status:'paid',amount_paid:invoice.total,metadata:{...invoice.metadata,sponsorshipId:'other-booking'}});
    await h.workflow.reconcile();const state=await h.store.read();
    assert.equal(state.orders[id].status,'signed');assert.ok(state.orders[id].reconciliationIssue);assert.equal(h.metrics.confirmations,0);
});

test('declines include optional reason, never create invoices, and cannot be accepted',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'decline',id,reason:'The timing does not work.'});
    await h.workflow.handle({op:'decline',id});await rejectsCode(h.workflow.handle({op:'approve',id}),409);
    const s=await h.store.read();assert.match(s.outbox[id+'-declined-client'].text,/timing does not work/);assert.equal(h.metrics.issues,0);assert.equal(Object.keys(s.holds).length,0);
});

test('configuration edits invalidate stale quotes; disabled integrations block requests',async()=>{
    const h=createHarness();await h.store.change(s=>s.config.revision++);await rejectsCode(h.submit(token,{offerRevision:1}),409);
    h.setReady(false);assert.equal((await h.workflow.handle({op:'offer'})).open,false);await rejectsCode(h.submit(),503);
    const s=await h.store.read();await rejectsCode(h.workflow.handle({op:'save-settings',revision:s.config.revision,config:s.config}),503);
});

test('agreement and package stay frozen after approval even if settings change',async()=>{
    const h=createHarness(),{id}=await h.submit(),approved=await h.workflow.handle({op:'approve',id});
    await h.store.change(s=>{s.config.package.amount=99999;s.config.terms.text='New terms';});await h.sign(id);
    const r=await h.workflow.handle({op:'status',id,token});assert.equal(r.package.amount,50000);assert.equal(r.agreement.hash,approved.agreement.hash);assert.notEqual(r.agreement.document.terms,'New terms');
});

test('notification claims prevent concurrent sends; uncertain delivery is quarantined after retention',async()=>{
    const h=createHarness();await h.submit();let sends=0,clock=100000;
    const sender={ready:()=>true,idempotencyWindowMs:86400000,send:async(_job,key)=>{sends++;return key;}};
    await Promise.all([dispatchOutbox(h.store,sender,()=>clock),dispatchOutbox(h.store,sender,()=>clock)]);assert.equal(sends,2);
    await h.store.change(s=>{const j=Object.values(s.outbox)[0];j.state='queued';j.firstAttemptAt=1;j.leaseUntil=0;});clock=86400002;
    await dispatchOutbox(h.store,sender,()=>clock);assert.equal(sends,2);assert.equal(Object.values((await h.store.read()).outbox)[0].state,'needs-review');
});

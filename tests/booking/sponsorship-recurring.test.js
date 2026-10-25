'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPayments}=require('../../functions-booking/sponsorship-providers');
const {packageConfig,paidRecord}=require('../../functions-booking/sponsorship-core');
const {packages}=require('../../functions-booking/sponsorship-presets');
const now=Date.parse('2026-10-14T20:00:00Z'),start=now/1000,end=Date.parse('2027-01-14T20:00:00Z')/1000;
function harness(billing='three_month'){
    const r={id:'a'.repeat(32),email:'test@example.test',business:'Synthetic sponsor',package:packageConfig(packages.find(p=>p.billing===billing)),agreement:{hash:'b'.repeat(64)},signature:{recurringConsent:true},status:'signed',billingStartedAt:now};
    const metadata={sponsorshipId:r.id,agreementHash:r.agreement.hash},calls=[];
    const price={id:'price_test',currency:'usd',unit_amount:r.package.amount,billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},product:'prod_test'};
    let sub={id:'sub_test',customer:'cus_test',status:'active',metadata,items:{data:[{price,quantity:1,current_period_start:start,current_period_end:start+31*86400}]},latest_invoice:'in_test',schedule:'sub_sched_test'};
    let invoice={id:'in_test',billing_reason:'subscription_create',number:'TEST',status:'draft',total:r.package.amount,currency:'usd',amount_paid:0,customer:'cus_test',parent:{subscription_details:{subscription:'sub_test',metadata}},lines:{data:[{period:{start,end:start+31*86400}}]},hosted_invoice_url:'https://invoice.stripe.com/i/synthetic'};
    let schedule;
    const client=createPayments({secret:()=> 'rk_test_synthetic',fetchImpl:async(url,options)=>{
        const path=url.split('/v1/')[1],p=Object.fromEntries(options.body||[]);calls.push({path,p,headers:options.headers});let result;
        if(path==='customers')result={id:'cus_test'};
        else if(path==='products')result={id:'prod_test'};
        else if(path==='subscription_schedules'){schedule={id:'sub_sched_test',customer:'cus_test',status:'active',metadata,subscription:sub.id,end_behavior:p.end_behavior,phases:[{metadata,items:[{price:price.id,quantity:1}],start_date:start,end_date:billing==='three_month'?end:start+31*86400}]};result=schedule;}
        else if(path==='subscription_schedules/sub_sched_test')result=schedule;
        else if(path==='subscription_schedules/sub_sched_test/release'){sub.schedule=null;result={...schedule,status:'released'};}
        else if(path==='subscriptions/sub_test'){
            if(p['payment_settings[save_default_payment_method]'])sub.payment_settings={save_default_payment_method:p['payment_settings[save_default_payment_method]']};
            if(p.cancel_at_period_end)sub.cancel_at_period_end=true;
            result=sub;
        }else if(path==='invoices/in_test'){if(p.auto_advance)invoice.auto_advance=false;result=invoice;}
        else if(path==='invoices/in_test/finalize'){invoice.status='open';result=invoice;}
        else throw new Error('Unexpected Stripe operation '+path);
        return {ok:true,status:200,json:async()=>structuredClone(result)};
    }});
    return {r,calls,client,invoice,sub,price,get schedule(){return schedule;},save:async change=>Object.assign(r,change)};
}
test('fixed exclusive billing is capped by Stripe before the first payment link exists',async()=>{
    const h=harness(),invoice=await h.client.issue(h.r,h.save,now);h.r.invoice={id:invoice.id};
    const call=h.calls.find(c=>c.path==='subscription_schedules');
    assert.equal(call.p.end_behavior,'cancel');assert.equal(call.p['phases[0][duration][interval]'],'month');assert.equal(call.p['phases[0][duration][interval_count]'],'3');
    assert.equal(call.p['phases[0][items][0][price_data][unit_amount]'],'400000');assert.equal(call.p['phases[0][items][0][quantity]'],'1');
    assert.equal(h.r.billing.endsAt,end*1000);assert.equal(h.r.stripeSubscriptionId,'sub_test');assert.equal(invoice.auto_advance,false);
    assert.ok(h.calls.every(c=>c.headers['Stripe-Version']==='2026-08-26.dahlia'));assert.ok(h.calls.every(c=>!Object.keys(c.p).some(k=>k.includes('payment_method_types'))));
    assert.ok(h.calls.some(c=>c.p['payment_settings[save_default_payment_method]']==='on_subscription'));
    await h.client.issue(h.r,h.save,now+1000);assert.equal(h.calls.filter(c=>c.path==='subscription_schedules').length,1);
});
test('monthly renewal continues until explicitly canceled at the period end',async()=>{
    const h=harness('monthly');await h.client.issue(h.r,h.save,now);
    assert.equal(h.calls.find(c=>c.path==='subscription_schedules').p.end_behavior,'release');
    const result=await h.client.cancelRenewal(h.r);assert.equal(result.cancelAtPeriodEnd,true);
    const release=h.calls.findIndex(c=>c.path.endsWith('/release')),cancel=h.calls.findIndex(c=>c.p.cancel_at_period_end==='true');assert.ok(release>=0&&cancel>release);
    const fixed=harness();await assert.rejects(fixed.client.cancelRenewal(fixed.r),/not a month-to-month/);assert.equal(fixed.calls.length,0);
});
test('fixed plan accepts Stripe scheduled cancellation only at the signed three-month boundary',async()=>{
    const fixed=harness();fixed.sub.cancel_at=end;
    await fixed.client.issue(fixed.r,fixed.save,now);
    assert.equal((await fixed.client.verifyInitialPlan(fixed.r)).endsAt,end*1000);
    for(const shifted of [end-86400,end+86400]){
        fixed.sub.cancel_at=shifted;await assert.rejects(fixed.client.verifyInitialPlan(fixed.r),/billing plan changed/);
    }
    const monthly=harness('monthly');monthly.sub.cancel_at=start+31*86400;
    await assert.rejects(monthly.client.issue(monthly.r,monthly.save,now),/billing plan changed/);
});
test('subscription payments are bound to the signed amount, customer, subscription and service month',async()=>{
    const h=harness(),invoice=await h.client.issue(h.r,h.save,now);let r={...h.r,invoice:{id:invoice.id}};
    const paid={...invoice,status:'paid',amount_paid:400000};
    for(const wrong of [{...paid,total:1},{...paid,customer:'cus_other'},{...paid,parent:{subscription_details:{subscription:'sub_wrong',metadata:paid.parent.subscription_details.metadata}}}])assert.throws(()=>paidRecord(r,wrong,now),/signed subscription/);
    r=paidRecord(r,paid,now);assert.equal(r.payments.length,1);assert.equal(paidRecord(r,paid,now).payments.length,1);
    assert.throws(()=>paidRecord(r,{...paid,id:'in_duplicate'},now),/already has a payment/);
    for(const [n,date,days] of [[2,'2026-11-14',30],[3,'2026-12-14',31]]){const at=Date.parse(date+'T20:00:00Z')/1000;r=paidRecord(r,{...paid,id:'in_'+n,lines:{data:[{period:{start:at,end:at+days*86400}}]}},now);}
    assert.equal(r.payments.reduce((sum,p)=>sum+p.amount,0),1200000);
    assert.throws(()=>paidRecord(r,{...paid,id:'in_4',lines:{data:[{period:{start:end,end:end+31*86400}}]}},now),/three-month commitment/);
});
test('recurring setup requires explicit consent and stops unsafe creation retries',async()=>{
    const h=harness();h.r.signature.recurringConsent=false;await assert.rejects(h.client.issue(h.r,h.save,now),/consent/);assert.equal(h.calls.length,0);
    h.r.signature.recurringConsent=true;await assert.rejects(h.client.issue(h.r,h.save,now+86400000),/review before retrying/);assert.equal(h.calls.length,0);
});
test('setup retries remain pinned to the first invoice even after latest_invoice changes',async()=>{
    const h=harness();
    await assert.rejects(h.client.issue(h.r,async change=>{await h.save(change);if(change.stripeInitialInvoiceId)throw new Error('simulated interruption');},now),/simulated interruption/);
    assert.equal(h.r.stripeInitialInvoiceId,'in_test');
    assert.ok(!h.calls.some(c=>c.path.endsWith('/finalize')));
    h.sub.latest_invoice='in_later_renewal';
    const invoice=await h.client.issue(h.r,h.save,now+1000);
    assert.equal(invoice.id,'in_test');
    assert.ok(!h.calls.some(c=>c.path.includes('in_later_renewal')));
});
test('a renewal invoice cannot be substituted for the first invoice',async()=>{
    const h=harness();h.invoice.billing_reason='subscription_cycle';
    await assert.rejects(h.client.issue(h.r,h.save,now),/initial invoice needs review/);
    assert.ok(!h.calls.some(c=>c.path.endsWith('/finalize')));
    assert.equal(h.r.stripeInitialInvoiceId,undefined);
});
test('monthly boundaries retain the original anchor through short months and leap years',()=>{
    const {monthBoundary}=require('../../functions-booking/sponsorship-recurring');
    for(const [date,months,expected] of [['2027-01-31',1,'2027-02-28'],['2027-01-31',2,'2027-03-31'],['2027-01-31',3,'2027-04-30'],['2028-01-31',1,'2028-02-29'],['2026-11-30',3,'2027-02-28']]){
        assert.equal(new Date(monthBoundary(Date.parse(date+'T20:00:00Z')/1000,months)*1000).toISOString(),expected+'T20:00:00.000Z');
    }
});
test('initial checkout rechecks saved Stripe plan identity, amount and exact three-month cap',async()=>{
    const mutations=[
        h=>h.schedule.end_behavior='release',
        h=>h.schedule.phases[0].end_date+=86400,
        h=>h.schedule.phases.push(structuredClone(h.schedule.phases[0])),
        h=>h.schedule.customer='cus_other',
        h=>h.sub.customer='cus_other',
        h=>h.sub.metadata={...h.sub.metadata,agreementHash:'wrong'},
        h=>h.sub.items.data[0].quantity=2,
        h=>h.price.unit_amount=500000,
        h=>h.price.recurring.interval='year',
        h=>h.price.recurring.interval_count=2,
        h=>h.price.product='prod_other',
        h=>h.schedule.phases[0].items[0].price='price_other',
        h=>h.schedule.phases[0].trial_end=start+86400,
        h=>h.schedule.phases[0].add_invoice_items=[{price:'extra'}],
        h=>h.schedule.phases[0].discounts=[{coupon:'unapproved'}],
        h=>h.sub.automatic_tax={enabled:true},
        h=>h.sub.items.data[0].current_period_start+=31*86400,
    ];
    for(const mutate of mutations){
        const h=harness();await h.client.issue(h.r,h.save,now);mutate(h);h.calls.length=0;
        await assert.rejects(h.client.verifyInitialPlan(h.r),/billing plan changed/);
        assert.ok(h.calls.every(c=>Object.keys(c.p).length===0),'validation must not change the Stripe plan');
    }
});
test('renewal payments require full anchored service months and do not rewind billing on late delivery',async()=>{
    const h=harness(),invoice=await h.client.issue(h.r,h.save,now);
    const paid={...invoice,status:'paid',amount_paid:400000};
    let r=paidRecord({...h.r,invoice:{id:invoice.id}},paid,now);
    const november=Date.parse('2026-11-14T20:00:00Z')/1000,december=Date.parse('2026-12-14T20:00:00Z')/1000;
    const renewal=(id,from,to)=>({...paid,id,lines:{data:[{period:{start:from,end:to}}]}});
    for(const wrong of [renewal('in_before',start-31*86400,start),renewal('in_shifted',november+86400,december+86400),renewal('in_partial',november,november+86400),renewal('in_extended',december,end+86400)])assert.throws(()=>paidRecord(r,wrong,now),/service dates/);
    r=paidRecord(r,renewal('in_december',december,end),now);
    r=paidRecord(r,renewal('in_november',november,december),now);
    assert.equal(r.payments.length,3);assert.equal(r.billing.periodStart,december*1000);assert.equal(r.billing.periodEnd,end*1000);assert.equal(r.billing.lastInvoiceId,'in_december');
});

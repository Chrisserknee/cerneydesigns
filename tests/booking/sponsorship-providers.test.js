'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCalendar,createPayments}=require('../../functions-booking/sponsorship-providers');
const {createHarness,fixedNow}=require('./helpers/sponsorship-fixture.cjs');
const auth={getClient:async()=>({getAccessToken:async()=>({token:'synthetic-token'})})};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
async function order(){const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});return (await h.store.read()).orders[id];}

test('every blocking calendar must return valid free/busy data',async()=>{
    const config={blockCalendarIds:['a','b']};
    for(const result of [{calendars:{a:{busy:[]}}},{calendars:{a:{busy:[]},b:{errors:[{reason:'forbidden'}]}}},{calendars:{a:{busy:[]},b:{busy:[{start:'invalid',end:'invalid'}]}}}]){
        const c=createCalendar({auth,fetchImpl:async()=>response(result)});await assert.rejects(c.busy(config,fixedNow,fixedNow+3600000),e=>e.code===503);
    }
});
test('Google all-day events, recurring expansion and pagination block time while own hold is excluded',async()=>{
    const r=await order(),calls=[];
    const c=createCalendar({auth,fetchImpl:async(url)=>{calls.push(url);return response(url.includes('pageToken=next')?
        {timeZone:'America/Los_Angeles',items:[{id:'all-day',start:{date:'2026-10-20'},end:{date:'2026-10-21'}}]}:
        {timeZone:'America/Los_Angeles',nextPageToken:'next',items:[{id:'sponsor'+r.id},{id:'free',transparency:'transparent'},{id:'deleted',status:'cancelled'}]});}});
    const ranges=await c.busy({calendarId:r.calendarId,blockCalendarIds:[r.calendarId],timeZone:r.slot.timeZone},fixedNow,fixedNow+86400000,r.id);
    assert.equal(ranges.length,1);assert.equal(new Date(ranges[0].start).toISOString(),'2026-10-20T07:00:00.000Z');assert.equal(new Date(ranges[0].end).toISOString(),'2026-10-21T07:00:00.000Z');assert.match(calls[0],/singleEvents=true/);assert.equal(calls.length,2);
});
test('an existing Google hold with a new conflict remains reserved for review',async()=>{
    const r=await order(),event={id:'sponsor'+r.id,extendedProperties:{private:{sponsorshipId:r.id}},start:{dateTime:'2026-10-20T15:30:00Z'},end:{dateTime:'2026-10-20T17:30:00Z'}};
    const c=createCalendar({auth,fetchImpl:async url=>response(url.includes('?')?{items:[event,{id:'conflict',start:{dateTime:'2026-10-20T16:00:00Z'},end:{dateTime:'2026-10-20T17:00:00Z'}}]}:event)});
    await assert.rejects(c.hold(r),e=>e.code===503);await assert.rejects(c.verifyHold(r),e=>e.code===409);
});

test('Stripe invoice issue resumes from saved IDs and never adds the line twice',async()=>{
    const r=await order();r.billingStartedAt=fixedNow;const calls=[],keys=new Map();let invoice=null,line=null;
    const fetchImpl=async(url,options)=>{
        const path=url.split('/v1/')[1],p=Object.fromEntries(options.body||[]),key=options.headers['Idempotency-Key'];calls.push({path,p,key});
        if(key&&keys.has(key))return response(keys.get(key));
        let d;
        if(path==='customers')d={id:'cus_test'};
        else if(path==='invoices'){assert.equal(p.pending_invoice_items_behavior,'exclude');assert.equal(p.auto_advance,'false');invoice={id:'in_test',number:null,customer:'cus_test',status:'draft',total:0,currency:'usd',collection_method:'send_invoice',metadata:{sponsorshipId:r.id,agreementHash:r.agreement.hash}};d=invoice;}
        else if(path==='invoices/in_test')d=invoice;
        else if(path==='invoices/in_test/lines?limit=100')d={data:line?[line]:[]};
        else if(path==='invoiceitems'){assert.equal(p.invoice,'in_test');line={id:'il_test',amount:Number(p.amount),currency:'usd',metadata:{sponsorshipId:r.id}};invoice.total=Number(p.amount);d=line;}
        else if(path==='invoices/in_test/finalize'){invoice={...invoice,status:'open',number:'TEST-001',hosted_invoice_url:'https://invoice.stripe.com/i/test'};d=invoice;}
        else throw new Error('Unexpected request: '+path);
        if(key)keys.set(key,structuredClone(d));return response(d);
    };
    const p=createPayments({secret:()=> 'sk_test_fixture',fetchImpl}),save=async changes=>Object.assign(r,changes);
    const first=await p.issue(r,save,fixedNow),second=await p.issue(r,save,fixedNow+1000);assert.equal(first.id,second.id);
    assert.equal(calls.filter(c=>c.path==='customers').length,1);assert.equal(calls.filter(c=>c.path==='invoices').length,1);assert.equal(calls.filter(c=>c.path==='invoiceitems').length,1);assert.equal(first.total,r.package.amount);
    invoice={...invoice,status:'draft'};keys.delete(r.id+'-finalize');await p.issue(r,save,fixedNow+2*86400000);assert.equal(calls.filter(c=>c.path==='invoiceitems').length,1);
});
test('a changed one-time invoice is rejected before finalization or adding any line',async()=>{
    const r=await order();r.billingStartedAt=fixedNow;r.stripeCustomerId='cus_test';r.invoice={id:'in_test'};
    const invoice={id:'in_test',customer:'cus_test',status:'draft',currency:'usd',collection_method:'send_invoice',metadata:{sponsorshipId:r.id,agreementHash:r.agreement.hash}};
    const line={id:'il_test',amount:r.package.amount,currency:'usd',metadata:{sponsorshipId:r.id}};
    const cases=[
        {invoice:{customer:'cus_other'}},{invoice:{metadata:{sponsorshipId:r.id,agreementHash:'changed'}}},
        {invoice:{collection_method:'charge_automatically'}},{invoice:{automatic_tax:{enabled:true}}},
        {invoice:{discounts:['di_other']}},{invoice:{default_tax_rates:['txr_other']}},
        {lines:{has_more:true,data:[line]}},{lines:{data:[line,line]}},
        {lines:{data:[{...line,metadata:{sponsorshipId:'other'}}]}},
        {lines:{data:[{...line,amount:r.package.amount-1}]}},
        {lines:{data:[{...line,currency:'eur'}]}},{lines:{data:[{...line,proration:true}]}},
        {lines:{data:[{...line,discount_amounts:[{amount:1}]}]}},
        {lines:{data:[{...line,taxes:[{amount:1}]}]}},
    ];
    for(const change of cases){
        const writes=[];
        const p=createPayments({secret:()=> 'sk_test_fixture',fetchImpl:async(url,options)=>{
            if(options.method!=='GET'){writes.push(url);throw Error('Must not mutate a changed invoice');}
            return response(url.includes('/lines?')?(change.lines||{data:[line]}):{...invoice,...change.invoice});
        }});
        await assert.rejects(p.issue(r,async()=>{},fixedNow),e=>e.code===409);assert.deepEqual(writes,[]);
    }
});
test('an unresolved Stripe creation after idempotency expiry stops for review',async()=>{
    const r=await order();r.billingStartedAt=fixedNow;let calls=0;
    const p=createPayments({secret:()=> 'sk_test_fixture',fetchImpl:async()=>{calls++;throw new Error('Must not create another invoice');}});
    await assert.rejects(p.issue(r,async()=>{},fixedNow+86400000),e=>e.code===409);assert.equal(calls,0);
});

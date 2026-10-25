'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('../../functions-booking/sponsorship-core'),schedule=require('../../functions-booking/sponsorship-schedule');
const {createHarness,configData,fixedNow}=require('./helpers/sponsorship-fixture.cjs');
test('DST, invalid dates, buffers and minimum notice cannot produce unsafe slots',()=>{
    assert.equal(new Date(schedule.localTimeToUtc('2026-10-20','09:00','America/Los_Angeles')).toISOString(),'2026-10-20T16:00:00.000Z');
    for(const [date,time] of [['2026-03-08','02:30'],['2026-11-01','01:30'],['2026-02-30','09:00'],['bad','12:00']])assert.throws(()=>schedule.localTimeToUtc(date,time,'America/Los_Angeles'));
    const busy=[{start:Date.parse('2026-10-20T17:00Z'),end:Date.parse('2026-10-20T18:00Z')}];
    const slots=schedule.buildSlots(configData,'2026-10-20',busy,{},fixedNow);assert.ok(slots.length>0);
    for(const s of slots)assert.equal(schedule.overlaps(schedule.slotInterval(s),busy[0]),false);
    assert.equal(schedule.buildSlots(configData,'2026-10-20',[],{},Date.parse('2026-10-20T16:00Z')).length,0);
});
test('intake is nonbinding; signature requires an approved immutable agreement',async()=>{
    const h=createHarness();await assert.rejects(h.submit('a'.repeat(64),{requestAcknowledged:false}));
    const {id}=await h.submit(),s=await h.store.read();assert.throws(()=>core.sign(s.orders[id],{},fixedNow));
    await h.workflow.handle({op:'approve',id});const r=(await h.store.read()).orders[id];
    assert.throws(()=>core.sign(r,{agreementHash:r.agreement.hash,signerName:'Client',signerTitle:'Owner',authorized:true,electronicConsent:false},fixedNow));
    const signed=await h.sign(id);assert.equal(signed.signature.agreementHash,r.agreement.hash);
});
test('payment requires exact signed request, Stripe invoice, currency and price',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);await h.workflow.handle({op:'checkout',id,token:'a'.repeat(64)});
    const r=(await h.store.read()).orders[id],invoice={...[...h.invoices.values()][0],status:'paid',amount_paid:r.package.amount};
    for(const bad of [{id:'wrong'},{status:'open'},{amount_paid:1},{total:1},{currency:'eur'},{metadata:{}},{metadata:{sponsorshipId:id,agreementHash:'wrong'}}])assert.throws(()=>core.paidRecord(r,{...invoice,...bad},fixedNow));
    assert.throws(()=>core.paidRecord({...r,signature:null},invoice,fixedNow));assert.equal(core.paidRecord(r,invoice,fixedNow).status,'paid');
});
test('public response strips capability tokens and signature audit metadata',async()=>{
    const h=createHarness(),{id}=await h.submit();await h.workflow.handle({op:'approve',id});await h.sign(id);
    const result=await h.workflow.handle({op:'status',id,token:'a'.repeat(64)});
    for(const field of ['token','tokenHash','clientKey','userAgent','email'])assert.equal(Object.hasOwn(result,field),false);
    assert.equal(Object.hasOwn(result.signature,'clientKey'),false);assert.equal(core.validToken('b'.repeat(64),core.hash('a'.repeat(64))),false);
});
test('gateway checks origin, closed booking and admin authentication before backend calls',async()=>{
    const handler=require('../../api/_lib/booking-handler'),old=process.env.BOOKING_ENABLED;delete process.env.BOOKING_ENABLED;
    const invoke=async(op,headers)=>{const r={setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};await handler({method:'POST',headers,body:{op}},r);return r;};
    try{
        const access=require('../../api/_lib/booking-auth');process.env.BOOKING_SESSION_SECRET='fixture'.repeat(10);process.env.BOOKING_PASSWORD_HASH='scrypt:fixture:fixture';
        const headers={cookie:access.issue().split(';')[0],origin:'https://cerneyselects.com','content-type':'application/json'};
        assert.equal((await invoke('offer',{...headers,cookie:''})).code,401);assert.equal((await invoke('offer',headers)).code,503);assert.equal((await invoke('offer',{...headers,origin:'https://attacker.test'})).code,403);
        for(const op of ['list','approve','decline','settings','save-settings'])assert.equal((await invoke(op,headers)).code,401);
    }finally{if(old===undefined)delete process.env.BOOKING_ENABLED;else process.env.BOOKING_ENABLED=old;}
});

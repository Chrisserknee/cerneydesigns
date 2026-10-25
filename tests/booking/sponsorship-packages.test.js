'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHarness,configData,fixedNow,drawingData}=require('./helpers/sponsorship-fixture.cjs');
const {draft}=require('../../functions-booking/sponsorship-presets');
const {validateConfig}=require('../../functions-booking/sponsorship-workflow');
const schedule=require('../../functions-booking/sponsorship-schedule');
const {createCalendar}=require('../../functions-booking/sponsorship-providers');
async function setup(options){const h=createHarness(options);await h.store.change(s=>{s.config=validateConfig({...structuredClone(draft),enabled:true,terms:{...draft.terms,approved:true}},s.config);});return h;}
const request={packageId:'reporter-feature',category:'Coffee shop',market:'Monterey County',slotStart:'2026-10-20T20:00:00.000Z'};
test('weekly hours follow Pacific daylight saving time and closed-date overrides',()=>{
    const c=validateConfig({...draft,enabled:false}, {revision:0});
    c.package=c.packages[0];
    assert.equal(schedule.buildSlots(c,'2026-10-20',[],{},fixedNow)[0].start,'2026-10-20T20:00:00.000Z');
    assert.equal(schedule.buildSlots(c,'2026-11-03',[],{},fixedNow)[0].start,'2026-11-03T21:00:00.000Z');
    assert.equal(schedule.buildSlots(c,'2026-10-19',[],{},fixedNow).length,0);
    c.windows=[{date:'2026-10-20',closed:true}];assert.equal(schedule.buildSlots(c,'2026-10-20',[],{},fixedNow).length,0);
    c.windows=[{date:'2026-10-20',start:'15:00',end:'17:00'}];assert.equal(schedule.buildSlots(c,'2026-10-20',[],{},fixedNow).length,0);
});
test('a submitted package uses server price, duration and billing, not client-provided values',async()=>{
    const h=await setup(),{id}=await h.submit('a'.repeat(64),{...request,amount:1,billing:'monthly',durationMinutes:30});
    const r=(await h.store.read()).orders[id];assert.equal(r.package.amount,60000);assert.equal(r.package.billing,'once');assert.equal(Date.parse(r.slot.end)-Date.parse(r.slot.start),3*3600000);
    await assert.rejects(h.submit('b'.repeat(64),{...request,packageId:'invented'}),/current package/);
    await assert.rejects(h.workflow.handle({op:'availability',date:'2026-10-20',packageId:'invented'}),/current package/);
});
test('the campaign tier freezes four monthly videos at $2,500 without category exclusivity',async()=>{
    const h=await setup(),{id}=await h.submit('a'.repeat(64),{...request,packageId:'monthly-campaign',amount:1,videoCount:20,exclusive:true});
    const approved=await h.workflow.handle({op:'approve',id});
    assert.equal(approved.package.amount,250000);assert.equal(approved.package.videoCount,4);assert.equal(approved.package.billing,'monthly');
    assert.equal(approved.package.exclusive,false);assert.equal(approved.exclusivity,null);
    assert.equal(approved.agreement.document.package.videoCount,4);assert.match(approved.agreement.document.billingDescription,/2,500.00 per month/);
    const options=(await h.workflow.handle({op:'offer'})).packages;
    assert.deepEqual(options.filter(p=>p.exclusive).map(p=>[p.amount,p.videoCount,p.billing]),[[400000,2,'monthly'],[400000,2,'three_month']]);
});
test('the recurring launch gate stops acceptance and opening untested plans',async()=>{
    const h=await setup({recurringReady:false}),{id}=await h.submit('a'.repeat(64),{...request,packageId:'monthly-partner'});
    await assert.rejects(h.workflow.handle({op:'approve',id}),/sandbox verification/);assert.equal(h.metrics.holds,0);
    const {config}=await h.workflow.handle({op:'settings'});await assert.rejects(h.workflow.handle({op:'save-settings',revision:config.revision,config}),/sandbox verification/);
});
test('exclusivity requires owner scope review and blocks exact competing reservations',async()=>{
    const h=await setup(),{id}=await h.submit('a'.repeat(64),{...request,packageId:'exclusive-three-month'});
    await assert.rejects(h.workflow.handle({op:'approve',id}),/Review category/);
    const r=await h.workflow.handle({op:'approve',id,conflictsReviewed:true,category:'Coffee shops',market:'Monterey County',exceptions:'None'});
    assert.equal(r.agreement.document.exclusivity.category,'Coffee shops');assert.match(r.agreement.document.exclusivityTerms,/three monthly installments/);
    const second=await h.submit('b'.repeat(64),{...request,category:'Coffee shops',slotStart:'2026-10-21T20:00:00.000Z'});
    await assert.rejects(h.workflow.handle({op:'approve',id:second.id,conflictsReviewed:true}),/existing exclusive partner/);
});
test('recurring consent is separate from drawing the signature',async()=>{
    const h=await setup(),{id}=await h.submit('a'.repeat(64),{...request,packageId:'monthly-partner'});
    const r=await h.workflow.handle({op:'approve',id});
    await assert.rejects(h.workflow.handle({op:'sign',id,token:'a'.repeat(64),agreementHash:r.agreement.hash,signerName:'Test',signerTitle:'Owner',signatureDrawing:drawingData,authorized:true,electronicConsent:true}),/recurring billing/);
    await h.sign(id);assert.equal((await h.store.read()).orders[id].signature.recurringConsent,true);
});
test('ignoring a booking hold still uses only free/busy on a personal calendar',async()=>{
    const calls=[],c=createCalendar({auth:{getClient:async()=>({getAccessToken:async()=>({token:'test'})})},fetchImpl:async(url,options)=>{
        calls.push({url,body:options.body&&JSON.parse(options.body)});
        return {ok:true,status:200,json:async()=>url.endsWith('freeBusy')?{calendars:{personal:{busy:[{start:'2026-10-20T20:00:00Z',end:'2026-10-20T21:00:00Z'}]}}}:{items:[{id:'sponsorrequest'}]}};
    }});
    const ranges=await c.busy({calendarId:'shoots',blockCalendarIds:['personal','shoots'],timeZone:'America/Los_Angeles'},fixedNow,fixedNow+86400000,'request');
    assert.equal(ranges.length,1);assert.deepEqual(calls[0].body.items,[{id:'personal'}]);assert.ok(calls[1].url.includes('/calendars/shoots/events'));assert.ok(!calls.some(c=>c.url.includes('/calendars/personal/events')));
});

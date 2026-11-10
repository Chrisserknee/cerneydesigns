'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {draft}=require('../../functions-booking/booking-premium-presets');
const {validateConfig}=require('../../functions-booking/sponsorship-workflow');
const {buildSlots,windowsFor,offeredDates}=require('../../functions-booking/sponsorship-schedule');
const {createHarness,fixedNow}=require('./helpers/sponsorship-fixture.cjs');
async function setup(){const h=createHarness();const c=structuredClone(draft);c.enabled=true;c.terms.approved=true;c.windows=[{date:'2026-10-20',start:'09:00',end:'17:00'}];await h.workflow.handle({op:'save-settings',revision:1,config:c});return h;}
const request={packageId:'promotional-video',videoStyleId:'chris-tries-it',category:'Test shop',market:'Test city'};
test('premium default has exact prices and durations, no dates and unapproved terms',()=>{
 const c=validateConfig(draft,{revision:0});assert.equal(c.enabled,false);assert.equal(c.terms.approved,false);assert.deepEqual(c.packages.map(p=>[p.amount,p.durationMinutes,p.priceType,p.billing]),[[100000,120,'from','once'],[175000,180,'fixed','once']]);assert.deepEqual(offeredDates(c,fixedNow),[]);
 assert.throws(()=>validateConfig({...c,enabled:true,terms:{...c.terms,approved:true}},{revision:1}),/filming hours/);
});
test('selected dates never fall back to weekly hours; closed-only dates cannot open requests',()=>{
 const c={...draft,weeklyWindows:[{day:2,start:'09:00',end:'17:00'}],windows:[{date:'2026-10-20',closed:true}]};
 assert.deepEqual(windowsFor(c,'2026-10-27'),[]);assert.deepEqual(offeredDates(c,fixedNow),[]);
 assert.throws(()=>validateConfig({...c,enabled:true,terms:{...c.terms,approved:true}},{revision:1}),/filming hours/);
});
test('each package has dates long enough for filming; paused offers reveal none',async()=>{
 const h=await setup();await h.store.change(s=>{s.config.windows=[{date:'2026-10-20',start:'09:00',end:'11:00'}];});
 let offer=await h.workflow.handle({op:'offer'});assert.deepEqual(offer.datesByPackage['promotional-video'],['2026-10-20']);assert.deepEqual(offer.datesByPackage['event-coverage'],[]);
 await h.store.change(s=>s.config.enabled=false);offer=await h.workflow.handle({op:'offer'});assert.deepEqual(offer.dates,[]);assert.ok(Object.values(offer.datesByPackage).every(d=>!d.length));
});
test('server freezes durations and rejects invented or busy times',async()=>{
 const h=await setup();await assert.rejects(h.submit('a'.repeat(64),{...request,slotStart:'2026-10-21T16:00:00.000Z'}),/no longer available/);
 h.calendar.external=[{start:Date.parse('2026-10-20T15:00:00Z'),end:Date.parse('2026-10-20T19:00:00Z')}];await assert.rejects(h.submit('a'.repeat(64),request),/no longer available/);h.calendar.external=[];
 const {id}=await h.submit('a'.repeat(64),{...request,amount:1,durationMinutes:1});const r=(await h.store.read()).orders[id];assert.equal(r.package.amount,100000);assert.equal(Date.parse(r.slot.end)-Date.parse(r.slot.start),120*60000);
 await assert.rejects(h.workflow.handle({op:'checkout',id,token:'a'.repeat(64)}),/Sign the agreement/);assert.equal(h.metrics.issues,0);
});
test('approval quote must meet starting price and freezes in agreement and invoice',async()=>{
 const h=await setup(),{id}=await h.submit('a'.repeat(64),request);
 for(const quoteAmount of [undefined,99999,100000.5,Infinity])await assert.rejects(h.workflow.handle({op:'approve',id,quoteAmount}),/final price/);
 assert.equal(h.metrics.holds,0);
 const approved=await h.workflow.handle({op:'approve',id,quoteAmount:125000,approvedScope:'One edited promotional video. Two hours filming. Agreed delivery.'});assert.equal(approved.agreement.document.package.amount,125000);assert.equal(approved.package.priceType,'fixed');assert.match(approved.package.billingDescription,/1,250.00 once/);
 await h.workflow.handle({op:'approve',id,quoteAmount:200000});assert.equal((await h.store.read()).orders[id].package.amount,125000);
 await h.sign(id);await h.workflow.handle({op:'checkout',id,token:'a'.repeat(64)});assert.equal([...h.invoices.values()][0].total,125000);assert.equal(h.metrics.issues,1);
 const invoice=[...h.invoices.values()][0];invoice.status='paid';invoice.amount_paid=125000;await h.workflow.paymentReceived(invoice);await h.workflow.paymentReceived(invoice);assert.equal((await h.store.read()).orders[id].calendarConfirmed,true);assert.equal(h.metrics.confirmations,1);
});
test('fixed event stays $1750 and three hours through approval and payment; decline never bills',async()=>{
 const h=await setup(),{id}=await h.submit('a'.repeat(64),{...request,packageId:'event-coverage',videoStyleId:undefined});
 await assert.rejects(h.workflow.handle({op:'approve',id,quoteAmount:100000}),/fixed price/);const r=await h.workflow.handle({op:'approve',id});assert.equal(r.package.amount,175000);assert.equal(Date.parse(r.slot.end)-Date.parse(r.slot.start),180*60000);await h.sign(id);await h.workflow.handle({op:'checkout',id,token:'a'.repeat(64)});assert.equal([...h.invoices.values()][0].total,175000);
 const other=await setup(),n=await other.submit('b'.repeat(64),request);await other.workflow.handle({op:'decline',id:n.id});await assert.rejects(other.workflow.handle({op:'checkout',id:n.id,token:'b'.repeat(64)}),/Sign the agreement/);assert.equal(other.metrics.issues,0);assert.equal(other.metrics.holds,0);
});
test('calendar errors fail closed and busy buffers prevent overlapping shoots',async()=>{
 const h=await setup();h.calendar.failure=new Error('Calendar unavailable');await assert.rejects(h.submit('a'.repeat(64),request),/Calendar unavailable/);assert.equal(Object.keys((await h.store.read()).orders).length,0);
 const c=validateConfig({...draft,windows:[{date:'2026-10-20',start:'09:00',end:'17:00'}]},{revision:0});c.package=c.packages[0];const busy=[{start:Date.parse('2026-10-20T18:15:00Z'),end:Date.parse('2026-10-20T19:00:00Z')}];assert.ok(!buildSlots(c,'2026-10-20',busy,{},fixedNow).some(s=>s.start==='2026-10-20T16:00:00.000Z'));
});

test('a calendar hold conflict restores the starting-price request for owner review',async()=>{
 const h=await setup(),{id}=await h.submit('a'.repeat(64),request);
 h.calendar.hold=async()=>{throw Object.assign(new Error('Conflict'),{code:409});};
 await assert.rejects(h.workflow.handle({op:'approve',id,quoteAmount:125000}),/Conflict/);
 const r=(await h.store.read()).orders[id];assert.equal(r.status,'pending');assert.equal(r.package.priceType,'from');assert.equal(r.package.amount,100000);assert.equal(r.agreement,null);assert.equal(h.metrics.issues,0);
 await assert.rejects(h.workflow.handle({op:'approve',id}),/final price/);
});
test('video style is server-defined and persists in review, agreement, and notification',async()=>{
 const h=await setup();await assert.rejects(h.submit('a'.repeat(64),{...request,videoStyleId:'invented'}),/Choose a video style/);
 const {id}=await h.submit('a'.repeat(64),{...request,videoStyle:{title:'Fake label'},maxVideoSeconds:9999});let r=await h.workflow.handle({op:'status',id,token:'a'.repeat(64)});
 assert.equal(r.videoStyle.title,'Chris tries it');assert.equal(r.package.maxVideoSeconds,179);assert.equal(r.package.durationMinutes,120);
 const notification=Object.values((await h.store.read()).outbox).find(j=>j.type==='request-owner');assert.match(notification.text,/Video style: Chris tries it/);assert.match(notification.text,/2 minutes 59 seconds/);
 r=await h.workflow.handle({op:'approve',id,quoteAmount:100000});assert.equal(r.agreement.document.videoStyle.id,'chris-tries-it');assert.equal(r.agreement.document.package.maxVideoSeconds,179);assert.match(r.agreement.document.terms,/On-location filming time is separate/);
});
test('event coverage has a longer-recap description and the same 179-second cap, without promotional styles',async()=>{
 const h=await setup();await assert.rejects(h.submit('a'.repeat(64),{...request,packageId:'event-coverage'}),/does not offer/);
 const {id}=await h.submit('a'.repeat(64),{...request,packageId:'event-coverage',videoStyleId:undefined});const r=await h.workflow.handle({op:'status',id,token:'a'.repeat(64)});
 assert.equal(r.package.durationMinutes,180);assert.equal(r.package.maxVideoSeconds,179);assert.match(r.package.videoLengthNote,/longer recap/);assert.equal(r.videoStyle,undefined);
});

const test=require('node:test'),assert=require('node:assert/strict');
const {snapshot}=require('../tip-alerts/source-health');
const now=Date.parse('2026-10-27T02:40:00Z'),fresh='2026-10-27T02:39:00Z';
test('connected publishing and blocked checks remain independent',()=>{
 const h=snapshot({checkedAt:fresh,sourceHealth:{version:1,collectors:[{id:'official-pages',status:'blocked',lastAttemptAt:fresh,summary:'Source check blocked.'}]}},now);
 assert.equal(h.publishing.stateLabel,'Connected');assert.equal(h.collectors[0].stateLabel,'Check blocked');assert.equal(h.headline,'Sources need attention');
});
test('recent legacy receipt with blocked coverage never renders as healthy',()=>{
 const h=snapshot({checkedAt:fresh,collection:{lastReportAt:fresh,coverage:[{status:'blocked'}]}},now);
 assert.equal(h.collectors[0].status,'blocked');assert.equal(h.needsAttention,true);
});
test('old group receipts cannot be freshened by a publisher timestamp or optimistic cached state',()=>{
 const h=snapshot({checkedAt:fresh,sourceHealth:{version:1,collectors:[{id:'facebook-groups',status:'healthy',lastReceiptAt:'2026-10-20T08:00:00Z'}]}},now);
 assert.equal(h.collectors[0].status,'stale');assert.equal(h.needsAttention,true);
});
test('intentional pause and scheduled overnight gap are neutral',()=>{
 const h=snapshot({checkedAt:fresh,sourceHealth:{version:1,collectors:[{id:'facebook-groups',status:'paused',lastReceiptAt:'2026-10-20T08:00:00Z'},{id:'official-pages',status:'scheduled',nextScheduledAt:'2026-10-27T08:00:00Z'}]}},now);
 assert.equal(h.needsAttention,false);assert.equal(h.collectors[0].status,'paused');assert.equal(h.collectors[1].stateLabel,'On schedule');
});
test('old or future publishing timestamps cannot imply a connected Mac',()=>{
 for(const checkedAt of ['2026-10-20T08:00:00Z','2030-01-01T00:00:00Z',null])assert.equal(snapshot({checkedAt},now).publishing.status,'stale');
});
test('unknown collector IDs and raw private state fields never enter the presentation',()=>{
 const h=snapshot({checkedAt:fresh,sourceHealth:{version:1,collectors:[{id:'private-token',label:'Secret',status:'healthy'},{id:'official-pages',label:'Secret',status:'blocked',credentials:'Secret'}]}},now);
 assert.equal(h.collectors.length,2);assert.equal(h.collectors[0].label,'Official agency pages');assert(!JSON.stringify(h).includes('Secret'));
});
test('missing or prototype-named collectors cannot hide missing coverage',()=>{
 const h=snapshot({checkedAt:fresh,sourceHealth:{version:1,collectors:[{id:'toString',status:'healthy'},{id:'facebook-groups',status:'healthy',lastReceiptAt:'2030-01-01T00:00:00Z'}]}},now);
 assert.deepEqual(h.collectors.map(r=>r.status),['unknown','unknown']);assert.equal(h.needsAttention,true);
});
test('malformed and missing health remains readable without claiming coverage',()=>{
 for(const input of [null,{}, {collection:{coverage:[]}}, {sourceHealth:{version:1,collectors:[null]}}])assert.equal(snapshot(input,now).needsAttention,true);
});

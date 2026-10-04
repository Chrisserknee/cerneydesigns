const test=require('node:test'),assert=require('node:assert/strict');
const {sourceContext,displayContext}=require('./tip-inbox-context');
const tip={id:'a'.repeat(64),path:'tips/example/_submission.json',sourceGeneration:'123',...sourceContext({whatHappened:'Riders near the waterfront',location:'Monterey',senderContact:'SECRET',contextKeyHash:'SECRET'})};
test('source context includes only descriptive fields and prefers verified follow-up receipt',()=>{
 assert.doesNotMatch(JSON.stringify(tip),/SECRET/);
 const result=sourceContext({whatHappened:'Old'}, {whatHappened:'New context',location:'New location',receivedAt:'2026-10-04T12:00:00Z'});
 assert.equal(result.sourceTitle,'New context');assert.equal(result.contextReceivedAt,'2026-10-04T12:00:00Z');
});
test('Claude enrichment requires the same canonical tip and source generation',()=>{
 const r={version:1,id:tip.id,source:tip.path,sourceGeneration:'123',title:'Bicycle riders in Monterey',summary:'A short draft description.',contextSource:'claude',state:'ready',revision:2};
 assert.equal(displayContext(tip,r).contextSource,'claude');
 for(const other of [{...r,source:'other'},{...r,sourceGeneration:'999'},{...r,id:'wrong'}])assert.equal(displayContext(tip,other).contextSource,'tipster');
});
test('new tipster context takes priority over stale Claude output',()=>{
 const t={...tip,contextReceivedAt:'2026-10-04T12:00:00Z'};
 const r={version:1,id:t.id,source:t.path,sourceGeneration:'123',title:'Old',contextSource:'claude',sourceContextAt:'2026-10-04T11:00:00Z'};
 assert.equal(displayContext(t,r).title,t.sourceTitle);
 assert.equal(displayContext(t,{...r,sourceContextAt:'2026-10-04T12:00:00Z'}).title,'Old');
});

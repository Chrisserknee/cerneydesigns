'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {facebookPost,withDetails,monitorHealth}=require('./newsroom-details');
test('only actual Facebook post links can leave the private inbox',()=>{
 for(const s of ['javascript:alert(1)','https://facebook.com.evil.test/a/posts/x','https://user@facebook.com/a/posts/x','https://facebook.com:444/a/posts/x','https://facebook.com/login','https://facebook.com/'])assert.equal(facebookPost(s),'');
 assert.equal(facebookPost('https://www.facebook.com/agency/posts/123#tracking'),'https://www.facebook.com/agency/posts/123');
});
test('source details require the current report identity and revision, and expose only bounded fields',()=>{
 const card={id:'a'.repeat(64),reportRevision:2,title:'Title'},data={version:1,id:card.id,revision:2,agency:'Agency',sourceText:'Complete release',sourceKind:'facebook',sourceUrl:'https://www.facebook.com/agency/posts/123',verificationNotes:['Verify the date'],privateContact:'secret',cookie:'secret'};
 for(const patch of [{id:'b'.repeat(64)},{revision:1},{version:2}])assert.deepEqual(withDetails(card,{...data,...patch}),card);
 const d=withDetails(card,data);assert.equal(d.agency,'Agency');assert.equal(d.sourceText,'Complete release');assert.equal(d.cookie,undefined);assert.equal(d.privateContact,undefined);
 assert.equal(withDetails(card,{...data,sourceText:'x'.repeat(12001)}).sourceText,'');
});
test('health output never leaks arbitrary state or treats absent timestamps as a live check',()=>{
 assert.equal(monitorHealth({version:1,updatedAt:'bad'}),null);assert.equal(monitorHealth(null),null);
 const d=monitorHealth({version:1,updatedAt:'2026-10-20T21:00:00Z',agencyCount:29,pendingCount:10,collectionStatus:'catching_up',lastAttemptAt:'bad',secret:'secret'});
 assert.equal(d.lastAttemptAt,null);assert.equal(d.agencyCount,29);assert.equal(d.collectionStatus,'catching_up');assert.equal(d.secret,undefined);
});

test('draft video links stay on Drive and bounded duration survives enrichment',()=>{
 const card={id:'a'.repeat(64),reportRevision:2};
 const details={version:1,id:card.id,revision:2,videoUrl:'https://drive.google.com/file/d/1234567890abcdef/view',durationSeconds:26.5};
 assert.equal(withDetails(card,details).videoUrl,details.videoUrl);
 assert.equal(withDetails(card,details).durationSeconds,26.5);
 for(const u of ['https://drive.google.com.evil.test/file/d/1234567890abcdef/view','javascript:alert(1)'])assert.equal(withDetails(card,{...details,videoUrl:u}).videoUrl,'');
});

test('producer health shows bounded recovery counts without chat identities',()=>{
 const d=monitorHealth({version:1,updatedAt:'2026-10-20T21:00:00Z',producer:{observedAt:'2026-10-20T21:00:00Z',status:'waiting_for_resume',resumeCount:3,failedCount:1,waitingCount:-2,activeCount:2,sessionId:'private'}});
 assert.equal(d.producer.resumeCount,3);assert.equal(d.producer.failedCount,1);assert.equal(d.producer.waitingCount,0);assert.equal(d.producer.sessionId,undefined);
 assert.equal(monitorHealth({version:1,updatedAt:'2026-10-20T21:00:00Z',producer:{observedAt:'bad'}}).producer,null);
});

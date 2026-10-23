const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {displayContext}=require('./tip-inbox-context');
const hash=s=>createHash('sha256').update(s).digest('hex');
const source='tips/example/_submission.json',id=hash(source);
const tip={id,path:source,sourceGeneration:'42',driveUrl:'https://drive.google.com/drive/folders/raw'};
const report={version:1,id,source,sourceGeneration:'42',revision:2,state:'ready',title:'Reviewed headline',contextSource:'claude'};
const delivery={version:1,id,source,sourceGeneration:'42',jobId:hash('tip-line-8c2d7.firebasestorage.app/'+source+'#42').slice(0,20),revision:2,state:'ready',draftDelivered:true,updatedAt:'2026-10-11T04:00:00Z',driveUrl:'https://drive.google.com/drive/folders/finished'};
test('private card opens the verified finished-report folder',()=>{assert.equal(displayContext(tip,report,delivery).driveUrl,delivery.driveUrl);});
test('other tip identity, generation, revision, or unsafe URL cannot replace the card destination',()=>{
 for(const patch of [{id:'b'.repeat(64)},{jobId:'b'.repeat(20)},{source:'tips/other/_submission.json'},{sourceGeneration:'41'},{revision:1},{state:'rendering'},{draftDelivered:false},{driveUrl:'https://example.com/evil'}])assert.equal(displayContext(tip,report,{...delivery,...patch}).driveUrl,tip.driveUrl);
});
test('new unreviewed source context keeps the original tip link',()=>{
 assert.equal(displayContext({...tip,contextReceivedAt:'2026-10-11T04:01:00Z'},report,delivery).driveUrl,tip.driveUrl);
});
test('unfinished report or missing delivery keeps the existing behavior',()=>{
 assert.equal(displayContext(tip,{...report,state:'rendering'},delivery).driveUrl,tip.driveUrl);
 assert.equal(displayContext(tip,report).driveUrl,tip.driveUrl);
});

test('raw submission and original folder survive completed report enrichment',()=>{
 const raw={...tip,sourceSummary:'Original short account',sourceDescription:'Original full account\nwith a second line',sourceTiming:'Tonight',sourceLocation:'Monterey'};
 const result=displayContext(raw,report,delivery);
 assert.equal(result.reportComplete,true);
 assert.equal(result.submission.text,raw.sourceDescription);
 assert.equal(result.submission.driveUrl,tip.driveUrl);
 assert.equal(result.submission.timing,'Tonight');
 assert.equal(result.submission.complete,true);
 assert.equal(result.driveUrl,delivery.driveUrl);
 assert.equal(result.title,report.title);
 for(const candidate of [undefined,{...delivery,revision:1},{...delivery,draftDelivered:false},{...delivery,sourceGeneration:'41'}]) {
   assert.equal(displayContext(raw,report,candidate).reportComplete,false);
 }
 assert.equal(displayContext({...raw,contextReceivedAt:'2026-10-11T04:01:00Z'},report,delivery).reportComplete,false);
});

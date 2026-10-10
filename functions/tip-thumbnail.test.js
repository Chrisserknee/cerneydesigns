'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),vm=require('node:vm');
const {thumbnailDescriptor,verifiedThumbnailBytes}=require('./tip-thumbnail');
const {displayContext}=require('./tip-inbox-context');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
// Tiny JPEG SOF fixture checks the bounded byte/hash/dimension contract.
const jpeg=Buffer.from('ffd8ffc00011080001000103011100021100031100ffd9','hex');
const source='tips/2026-10-10_12-00-00_abcdefghijkl/_submission.json',id=hash(source),jobId=hash(`tip-line-8c2d7.firebasestorage.app/${source}#12`).slice(0,20);
const tip={id,path:source,sourceGeneration:'12',status:'ready',driveUrl:'https://drive.google.com/drive/folders/test',receivedAt:new Date().toISOString()};
const sha256=hash(jpeg);
const thumbnail={version:1,name:`_tipalerts/v1/thumbnails/${id}/${jobId}/r2-c1-${sha256}.jpg`,generation:'34',sha256,mimeType:'image/jpeg',sizeBytes:jpeg.length,width:1,height:1,revision:2,contextVersion:1,jobId};
const report={version:1,id,source,sourceGeneration:'12',state:'ready',revision:2,contextVersion:1,planContextVersion:1,draftDelivered:true,draftJobId:jobId,contextSource:'claude',title:'Test report',sourceContextAt:'2026-10-10T12:01:00Z',thumbnail};

test('finished thumbnail descriptor excludes storage paths and is available after approval',()=>{
    const descriptor=thumbnailDescriptor(tip,report);
    assert.equal(descriptor.sha256,sha256);assert.equal(descriptor.generation,'34');
    assert.doesNotMatch(JSON.stringify(descriptor),/name|jobId|_tipalerts|https|base64/);
    assert.deepEqual(displayContext(tip,report).thumbnail,descriptor);
    assert.ok(thumbnailDescriptor(tip,{...report,state:'approved'}));
});
test('pending, held, stale, undelivered, wrong-generation or wrong-job renders never have thumbnails',()=>{
    for(const state of ['queued','editing','rendering','held','failed','needs_review'])assert.equal(thumbnailDescriptor(tip,{...report,state}),null);
    for(const patch of [{draftDelivered:false},{sourceGeneration:'13'},{draftJobId:'x'.repeat(20)},
        {contextVersion:2},{planContextVersion:0},{source:'tips/other/_submission.json'},
        {thumbnail:{...thumbnail,generation:''}},{thumbnail:{...thumbnail,name:'tips/private.jpg'}},
        {thumbnail:{...thumbnail,sha256:'wrong'}},{thumbnail:{...thumbnail,sizeBytes:262145}},
        {thumbnail:{...thumbnail,width:1601}},{thumbnail:{...thumbnail,mimeType:'image/svg+xml'}}])
        assert.equal(thumbnailDescriptor(tip,{...report,...patch}),null);
    assert.equal(thumbnailDescriptor({...tip,contextReceivedAt:'2026-10-10T12:02:00Z'},report),null);
    assert.equal(thumbnailDescriptor({...tip,status:'processing'},report),null);
});
test('the served bytes must match the expected JPEG dimensions, size and digest',()=>{
    assert.equal(verifiedThumbnailBytes(jpeg,thumbnail),true);
    assert.equal(verifiedThumbnailBytes(Buffer.from('not a JPEG'),thumbnail),false);
    assert.equal(verifiedThumbnailBytes(jpeg,{...thumbnail,width:2}),false);
    assert.equal(verifiedThumbnailBytes(jpeg,{...thumbnail,sizeBytes:1}),false);
    assert.equal(verifiedThumbnailBytes(jpeg,{...thumbnail,sha256:'0'.repeat(64)}),false);
});

function harness({context,revoked=false,image=jpeg,imageMetadata={},replaceReport}={}){
    const token='x'.repeat(43),root='_tipalerts/v1/',files=new Map();let imageReads=0,reportReads=0;
    const put=(name,data,generation='1',metadata={})=>files.set(name,{bytes:Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data)),generation,...metadata});
    put(root+`devices/${hash(token)}.json`,{id:hash(token),sessionPolicy:'until-sign-out',expiresAt:null,...(revoked?{revokedAt:new Date().toISOString()}:{})});
    put(root+`tips/${id}.json`,tip);put(root+`enrichment/${id}.json`,report);
    put(source,{},'12',{metadata:{driveCopyStatus:'complete'}});
    if(context)put(source.replace('_submission.json','_context_ready.json'),context);
    put(thumbnail.name,image,'34',{contentType:'image/jpeg',...imageMetadata});
    const bucket={file(name,opts={}){return {getMetadata:async()=>{const item=files.get(name);if(!item || (opts.generation&&String(opts.generation)!==item.generation))throw Object.assign(Error(),{code:404});return [{name,generation:item.generation,size:String(item.bytes.length),...item}];},download:async()=>{const item=files.get(name);if(!item || (opts.generation&&String(opts.generation)!==item.generation))throw Object.assign(Error(),{code:404});if(name===thumbnail.name)imageReads++;if(name===root+`enrichment/${id}.json`&&++reportReads>1&&replaceReport)return [Buffer.from(JSON.stringify(replaceReport))];return [item.bytes];}};},getFiles:async({prefix})=>[[...files].filter(([name])=>name.startsWith(prefix)).map(([name,item])=>({name,metadata:{generation:item.generation}}))]};
    const c=vm.createContext({exports:{},Buffer,URL,Date,Intl,AbortSignal,require(name){
        if(name==='firebase-functions/params')return {defineSecret:()=>({value:()=> 'test-secret'.repeat(4)})};
        if(name==='firebase-admin/storage')return {getStorage:()=>({bucket:()=>bucket})};
        if(name==='web-push')return {};
        if(name==='firebase-functions')return {logger:{info(){},warn(){},error(){}}};
        if(name==='firebase-functions/v2/storage')return {onObjectFinalized:(_,f)=>f,onObjectMetadataUpdated:(_,f)=>f};
        if(name==='firebase-functions/v2/scheduler')return {onSchedule:(_,f)=>f};
        if(name==='firebase-functions/v2/https')return {onRequest:(_,f)=>f};
        return require(name);
    }});
    vm.runInContext(fs.readFileSync(__dirname+'/tip-alerts.js','utf8')+'\nthis.testing={handleApi};',c);
    return {files,get imageReads(){return imageReads;},async call(patch={}){const res={code:200,headers:{},set(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;}};await c.testing.handleApi({method:'POST',is:()=>true,body:{op:'thumbnail',token,id,...thumbnailDescriptor(tip,report),...patch}},res);return res;}};
}
test('thumbnail API authenticates before reading private image bytes and marks responses no-store',async()=>{
    const denied=harness({revoked:true});assert.equal((await denied.call()).code,401);assert.equal(denied.imageReads,0);
    const missing=harness();assert.equal((await missing.call({token:''})).code,401);assert.equal(missing.imageReads,0);
    const allowed=harness();const res=await allowed.call();assert.equal(res.code,200);assert.equal(res.body.thumbnail.base64,jpeg.toString('base64'));assert.equal(res.headers['Cache-Control'],'no-store');
    assert.doesNotMatch(JSON.stringify(res.body),/_tipalerts|jobId|https/);
});
test('thumbnail API rejects tampered request, obsolete revision, overwritten object and stale source',async()=>{
    const h=harness();assert.equal((await h.call({id:'../private'})).code,400);
    assert.equal((await h.call({revision:1})).code,404);assert.equal(h.imageReads,0);
    const replaced=harness();replaced.files.get(thumbnail.name).generation='35';assert.equal((await replaced.call()).code,404);assert.equal(replaced.imageReads,0);
    const sourceChanged=harness();sourceChanged.files.get(source).generation='13';assert.equal((await sourceChanged.call()).code,404);assert.equal(sourceChanged.imageReads,0);
});
test('new context, held report during retrieval and invalid image bytes fail closed',async()=>{
    const context={submissionName:source,submissionGeneration:'12',receivedAt:'2026-10-10T12:02:00Z'};
    const stale=harness({context});assert.equal((await stale.call()).code,404);assert.equal(stale.imageReads,0);
    assert.equal((await harness({replaceReport:{...report,state:'held'}}).call()).code,404);
    assert.equal((await harness({image:Buffer.from('wrong')}).call()).code,404);
    assert.equal((await harness({imageMetadata:{contentType:'text/html'}}).call()).code,404);
});

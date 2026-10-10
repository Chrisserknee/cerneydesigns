'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {loadThumbnail,publishThumbnail}=require('./thumbnail-upload.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tip-thumbnail-publish-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'thumbnails'));
 const bytes=fs.readFileSync(path.join(__dirname,'fixtures/banner-test.jpg')),file=path.join(root,'thumbnails','test.jpg');fs.writeFileSync(file,bytes);
 const cfg={bucket:'tip-line-8c2d7.firebasestorage.app'},source='tips/2026-10-10_12-00-00_abcdefghijkl/_submission.json';
 const id=sha(source),jobId=sha(`${cfg.bucket}/${source}#123`).slice(0,20);
 const item={version:1,id,source,sourceGeneration:'123',state:'ready',revision:2,contextVersion:1,planContextVersion:1,draftDelivered:true,draftJobId:jobId};
 item.thumbnail={version:1,jobId,revision:2,contextVersion:1,mimeType:'image/jpeg',sha256:sha(bytes),width:80,height:32,sizeBytes:bytes.length};
 item.thumbnail.name=`_tipalerts/v1/thumbnails/${id}/${jobId}/r2-c1-${item.thumbnail.sha256}.jpg`;
 const input={stateDir:root,thumbnailFiles:{[id]:file}};
 const metadata={name:item.thumbnail.name,generation:'456',contentType:'image/jpeg',cacheControl:'no-store',size:String(bytes.length),md5Hash:crypto.createHash('md5').update(bytes).digest('base64'),metadata:{sha256:item.thumbnail.sha256,tipId:id,jobId,sourceGeneration:'123'}};
 return {root,bytes,file,cfg,item,input,metadata};
}
const response=(status,body={})=>({status,ok:status>=200&&status<300,json:async()=>body});
test('only a current, delivered, correctly bound rendered preview can be uploaded',t=>{
 const f=fixture(t);assert.equal(loadThumbnail(f.item,f.input,f.cfg).bytes.length,f.bytes.length);
 for(const change of [{state:'held'},{draftDelivered:false},{planContextVersion:0},{draftJobId:'f'.repeat(20)},{revision:3}])assert.throws(()=>loadThumbnail({...f.item,...change},f.input,f.cfg));
 assert.ok(loadThumbnail({...f.item,state:'approved'},f.input,f.cfg));
 assert.equal(loadThumbnail({...f.item,thumbnail:null},f.input,f.cfg),null);
});
test('symlinks, outside files, tampered bytes and false dimensions are rejected',t=>{
 const f=fixture(t),link=path.join(f.root,'thumbnails','link.jpg');fs.symlinkSync(f.file,link);
 assert.throws(()=>loadThumbnail(f.item,{...f.input,thumbnailFiles:{[f.item.id]:link}},f.cfg));
 const other=path.join(f.root,'outside.jpg');fs.writeFileSync(other,f.bytes);
 assert.throws(()=>loadThumbnail(f.item,{...f.input,thumbnailFiles:{[f.item.id]:other}},f.cfg));
 assert.throws(()=>loadThumbnail({...f.item,thumbnail:{...f.item.thumbnail,width:81}},f.input,f.cfg));
 fs.writeFileSync(f.file,Buffer.alloc(f.bytes.length));assert.throws(()=>loadThumbnail(f.item,f.input,f.cfg));
});
test('private JPEG upload is immutable and descriptor records the verified storage generation',async t=>{
 const f=fixture(t),calls=[];
 const result=await publishThumbnail(f.item,f.input,f.cfg,async(url,options={})=>{
  calls.push({url,options});return calls.length===1?response(404):response(200,f.metadata);
 });
 assert.equal(result.generation,'456');assert.equal(calls.length,2);assert.match(calls[1].url,/ifGenerationMatch=0/);
 assert.equal(calls[1].options.method,'POST');assert.match(calls[1].options.body.toString(),/"cacheControl":"no-store"/);
 assert.equal(calls[1].options.body.includes(f.bytes),true);
});
test('an already verified image is reused and corrupt remote metadata cannot be published',async t=>{
 const f=fixture(t);let reads=0;
 const result=await publishThumbnail(f.item,f.input,f.cfg,async()=>{reads++;return response(200,f.metadata);});
 assert.equal(result.generation,'456');assert.equal(reads,1);
 for(const patch of [{md5Hash:'wrong'},{contentType:'text/html'},{cacheControl:'public'},{generation:'bad'}])await assert.rejects(()=>publishThumbnail(f.item,f.input,f.cfg,async()=>response(200,{...f.metadata,...patch})));
});
test('a simultaneous upload is re-read and verified instead of overwritten',async t=>{
 const f=fixture(t),statuses=[404,412,200];let calls=0;
 const result=await publishThumbnail(f.item,f.input,f.cfg,async()=>response(statuses[calls++],f.metadata));
 assert.equal(calls,3);assert.equal(result.generation,'456');
});

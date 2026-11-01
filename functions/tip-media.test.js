'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {mediaDescriptor,imageInfo,thumbnailURL,createTipMedia}=require('./tip-media');
const {displayContext}=require('./tip-inbox-context');
const sha=x=>createHash('sha256').update(x).digest('hex'),source='tips/2026-10-10_12-00-00_abcdefghijkl/_submission.json';
const tip={id:sha(source),path:source,sourceGeneration:'12',driveUrl:'https://drive.google.com/drive/folders/original',status:'ready'};
const jpeg=Buffer.from('ffd8ffc00011080001000103011100021100031100ffd9','hex');
function harness({preview,changedSource=false,rejected=false}={}){
 const records=new Map([[`tips/${tip.id}.json`,{data:tip,generation:'1'}]]),files=new Map([[source,{bytes:Buffer.from('{}'),generation:changedSource?'13':'12',metadata:rejected?{processingStatus:'rejected'}:{}}]]);
 let calls=0;
 const read=async name=>records.get(name)||null,write=async(name,data)=>records.set(name,{data,generation:'2'});
 const bucket=()=>({file(name,opts={}){return {
  async save(bytes,options){files.set(name,{bytes,generation:'10',contentType:options.contentType});},
  async getMetadata(){const f=files.get(name);if(!f||(opts.generation&&opts.generation!==f.generation))throw Object.assign(Error(),{code:404});return [{...f,size:f.bytes.length}];},
  async download(){return [files.get(name).bytes];}
 };}});
 const handle=createTipMedia({read,write,bucket,preview:async t=>{calls++;return preview?preview(t):{bytes:jpeg,count:3,kind:'video'};}});
 return {handle,records,files,get calls(){return calls;},body:{id:tip.id,mediaVersion:mediaDescriptor(tip).version}};
}
test('original media stays separate from the finished report and does not leak paths',()=>{
 const media=mediaDescriptor(tip);assert(media);assert.doesNotMatch(JSON.stringify(media),/https|tips\//);
 const report={version:1,id:tip.id,source,sourceGeneration:'12',state:'rendering',title:'Report',contextSource:'claude'};
 assert.deepEqual(displayContext(tip,report).media,media);
 assert.equal(mediaDescriptor({...tip,status:'rejected'}),null);
 assert.equal(mediaDescriptor({...tip,path:'private/something'}),null);
 assert.equal(mediaDescriptor({...tip,driveUrl:'https://evil.test/folder'}),null);
 assert.notEqual(mediaDescriptor({...tip,sourceGeneration:'13'}).version,media.version);
});
test('Google Voice attachments have a version without requiring a Drive folder',()=>{
 const voice={id:'a'.repeat(64),path:`_tipalerts/v1/voice-sources/${'a'.repeat(64)}.json`,sourceGeneration:'1',sourceKind:'google_voice',attachmentCount:2,mediaSummary:'2 photos · not inspected'};
 assert.equal(mediaDescriptor(voice).kind,'photo');assert.equal(mediaDescriptor({...voice,attachmentCount:0}),null);
 assert.equal(mediaDescriptor({...voice,path:source}),null);
});
test('image bytes are bounded and only private Google thumbnail hosts are accepted',()=>{
 assert.equal(imageInfo(jpeg).width,1);assert.equal(imageInfo(Buffer.alloc(262145)),null);assert.equal(imageInfo(Buffer.from('<svg/>')),null);
 const large=Buffer.from(jpeg);large.writeUInt16BE(2000,9);assert.equal(imageInfo(large),null);
 assert(thumbnailURL('https://lh3.googleusercontent.com/image'));
 for(const url of ['http://lh3.googleusercontent.com/a','https://googleusercontent.com.evil.test/a','https://user@lh3.googleusercontent.com/a','https://localhost/a','https://lh3.googleusercontent.com:8443/a'])assert.equal(thumbnailURL(url),null);
});
test('simultaneous card loads coalesce and repeat loads use the private cached poster',async()=>{
 const h=harness();const [a,b]=await Promise.all([h.handle(h.body),h.handle(h.body)]);
 assert.deepEqual(a,b);assert.equal(a.media.image.base64,jpeg.toString('base64'));assert.equal(a.media.kind,'video');assert.equal(a.media.count,3);assert.equal(h.calls,1);
 await h.handle(h.body);assert.equal(h.calls,1);
 const cache=h.records.get(`media-previews/${tip.id}.json`).data;h.files.get('_tipalerts/v1/'+cache.image.name).bytes=Buffer.from('broken');
 assert.equal((await h.handle(h.body)).media.image,undefined);
});
test('stale, replaced, rejected, or invalid source requests do not fetch media',async()=>{
 for(const options of [{changedSource:true},{rejected:true}]){const h=harness(options);assert.equal((await h.handle(h.body)).media,null);assert.equal(h.calls,0);}
 const h=harness();assert.equal((await h.handle({...h.body,mediaVersion:'0'.repeat(64)})).media,null);assert.equal(h.calls,0);
 await assert.rejects(h.handle({...h.body,id:'../secret'}));
});
test('pending Drive videos retain an indicator and back off between requests',async()=>{
 const h=harness({preview:()=>({count:1,kind:'video'})});
 assert.equal((await h.handle(h.body)).media.kind,'video');await h.handle(h.body);assert.equal(h.calls,1);
});
test('changing the source while the poster loads never serves the old attachment',async()=>{
 const h=harness({preview:async()=>{h.records.set(`tips/${tip.id}.json`,{data:{...tip,sourceGeneration:'13'},generation:'2'});return {bytes:jpeg,count:1,kind:'photo'};}});
 assert.equal((await h.handle(h.body)).media,null);
});

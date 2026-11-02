const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createFacebookMedia,manifest,inGroup}=require('./facebook-media');
const hash=x=>createHash('sha256').update(x).digest('hex'),rid=hash('report'),source='https://www.facebook.com/groups/1416333486418080/posts/123/';
const bytes=Buffer.from('fixture'),digest=hash(bytes);
const asset={id:hash('asset'),filename:'source.png',mimeType:'image/png',bytes:bytes.length,sha256:digest,parts:[{sha256:digest,bytes:bytes.length}],sourceURL:source,origin:'source_screenshot'};
const data={version:1,reportID:rid,assets:[asset]};
function handler(overrides={}){return createFacebookMedia({root:'_tipalerts/v1/',read:async name=>name.startsWith('research/')?{data:{sources:[{url:source}]}}:{data},bucket:()=>({file:(path,opts)=>({getMetadata:async()=>[{size:bytes.length,generation:'1'}],download:async()=>[bytes]})}),...overrides});}
test('only the selected Watchdog group qualifies',()=>{assert(inGroup(source));assert(!inGroup('https://www.facebook.com/groups/2891488804379003/posts/123/'));assert(!inGroup('https://facebook.com.evil.test/groups/1416333486418080/posts/123/'));});
test('private attachments preserve source and verify bytes',async()=>{const call=handler();assert.deepEqual((await call({op:'facebook-media-list',id:rid})).assets,[asset]);assert.equal((await call({op:'facebook-media-read',id:rid,assetID:asset.id,index:0})).sha256,digest);});
test('unknown reports and path traversal cannot read media',async()=>{await assert.rejects(handler()({op:'facebook-media-read',id:'../other',assetID:asset.id,index:0}),{code:400});await assert.rejects(handler({read:async()=>null})({op:'facebook-media-list',id:rid}),{code:404});});
test('source mismatch, excessive size, unsafe names and part sums rejected',()=>{for(const patch of [{sourceURL:'https://www.facebook.com/another/'},{filename:'../source.png'},{bytes:201*1024*1024},{bytes:2},{origin:'unknown'}])assert.throws(()=>manifest({...data,assets:[{...asset,...patch}]},rid,[source]));});
test('corrupted stored bytes fail closed',async()=>{const call=handler({bucket:()=>({file:()=>({getMetadata:async()=>[{size:bytes.length,generation:'1'}],download:async()=>[Buffer.from('corrupt')]})})});await assert.rejects(call({op:'facebook-media-read',id:rid,assetID:asset.id,index:0}),{code:409});});

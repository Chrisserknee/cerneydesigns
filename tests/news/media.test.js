'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable,Writable}=require('node:stream');
const {createHmac}=require('node:crypto');
const {createNewsMediaHandler}=require('../../functions/news-media');
const POST='11111111-1111-4111-8111-111111111111',MEDIA='22222222-2222-4222-8222-222222222222';
const NOW=Date.parse('2026-11-09T04:00:00Z'),SECRET='test-secret-not-used-outside-this-test';
class Response extends Writable {
    constructor(){super();this.headers={};this.statusCode=200;this.chunks=[];this.headersSent=false;}
    set(key,value){if(typeof key==='object'){for(const [k,v] of Object.entries(key))this.set(k,v);}else this.headers[key.toLowerCase()]=value;return this;}
    status(code){this.statusCode=code;return this;}
    _write(chunk,encoding,done){this.headersSent=true;this.chunks.push(Buffer.from(chunk));done();}
    end(...args){this.headersSent=true;return super.end(...args);}
    redirect(code,url){this.status(code).set('Location',url);return this.end();}
}
function fixture({status='published',publishAt=new Date(NOW-1000).toISOString(),type='image/jpeg',size=4,metadataError=false}={}){
    const record={id:MEDIA,type,size,generation:'7'};
    const calls={streams:0,signed:0,uploads:0};
    const handler=createNewsMediaHandler({now:()=>NOW,previewSecret:()=>SECRET,
        catalog:async()=>({posts:[{id:POST,status,publishAt,media:[record]}]}),
        readUpload:async()=>{calls.uploads++;return record;},
        fileFor:()=>({getMetadata:async()=>{if(metadataError)throw new Error('private provider detail');return [{size:String(size),contentType:type,generation:'7'}];},
            createReadStream:()=>{calls.streams++;return Readable.from(Buffer.from('jpeg'));},
            getSignedUrl:async()=>{calls.signed++;return ['https://storage.googleapis.com/test-only'];}})});
    const request=async changes=>{const res=new Response();await handler({method:'GET',query:{post:POST,media:MEDIA},headers:{},...changes},res);return res;};
    return {request,calls};
}
test('published small thumbnails stream at their stable URL and cache privately',async()=>{
    const {request,calls}=fixture(),res=await request();
    assert.equal(res.statusCode,200);assert.equal(Buffer.concat(res.chunks).toString(),'jpeg');
    assert.equal(res.headers['cache-control'],'private, max-age=300, must-revalidate');
    assert.equal(res.headers['content-type'],'image/jpeg');assert.equal(res.headers['content-length'],'4');
    assert.equal(calls.streams,1);assert.equal(calls.signed,0);
});
test('ETag revalidation avoids body transfer, after checking publication',async()=>{
    const {request,calls}=fixture();const first=await request(),etag=first.headers.etag;
    const second=await request({headers:{'if-none-match':etag}});
    assert.equal(second.statusCode,304);assert.equal(calls.streams,1);
    const withdrawn=await fixture({status:'draft'}).request({headers:{'if-none-match':etag}});
    assert.equal(withdrawn.statusCode,404);assert.equal(withdrawn.headers['cache-control'],'private, no-store');
});
test('draft and future media never become public or cacheable',async()=>{
    for(const options of [{status:'draft'},{publishAt:new Date(NOW+1000).toISOString()}]){
        const {request,calls}=fixture(options),res=await request();
        assert.equal(res.statusCode,404);assert.equal(res.headers['cache-control'],'private, no-store');
        assert.equal(calls.streams,0);assert.equal(calls.signed,0);
    }
});
test('signed private previews retain no-store redirects',async()=>{
    const {request,calls}=fixture({status:'draft'}),expires=String(NOW+60000);
    const signature=createHmac('sha256',SECRET).update(`news-preview:${MEDIA}:${expires}`).digest('hex');
    const res=await request({query:{media:MEDIA,expires,signature}});
    assert.equal(res.statusCode,302);assert.equal(res.headers['cache-control'],'private, no-store');
    assert.equal(calls.uploads,1);assert.equal(calls.streams,0);
});
test('video, range requests and large images keep direct storage delivery',async()=>{
    for(const [options,headers] of [[{type:'video/mp4'},{}],[{}, {range:'bytes=0-3'}],[{size:2*1024**2},{}]]){
        const {request,calls}=fixture(options),res=await request({headers});
        assert.equal(res.statusCode,302);assert.equal(res.headers['cache-control'],'private, no-store');
        assert.equal(calls.signed,1);assert.equal(calls.streams,0);
    }
});
test('HEAD sends image headers without reading the body',async()=>{
    const {request,calls}=fixture(),res=await request({method:'HEAD'});
    assert.equal(res.statusCode,200);assert.equal(res.headers['content-length'],'4');assert.equal(calls.streams,0);
});
test('invalid preview signatures, malformed IDs and provider errors fail closed',async()=>{
    const cases=[fixture({status:'draft'}).request({query:{media:MEDIA,expires:String(NOW+60000),signature:'0'.repeat(64)}}),fixture().request({query:{post:POST,media:'invalid'}}),fixture({metadataError:true}).request()];
    for(const res of await Promise.all(cases)){assert.equal(res.statusCode,404);assert.equal(res.headers['cache-control'],'private, no-store');assert.equal(Buffer.concat(res.chunks).length,0);}
});

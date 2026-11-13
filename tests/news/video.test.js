'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFile,writeFile}=require('node:fs/promises');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {sourceInfo,qualityLevels,inspectPlaylist,validRenditions,masterPlaylist,signedPlaylist}=require('../../functions/news-video-core');
const {createRenditionReader,decorateVideoPost}=require('../../functions/news-video-delivery');
const {createNewsMediaHandler}=require('../../functions/news-media');
const {eventTarget,createVideoProcessor}=require('../../functions/news-video-processing');
const POST='11111111-1111-4111-8111-111111111111',MEDIA='22222222-2222-4222-8222-222222222222';
const playlist='#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="video.mp4",BYTERANGE="2@0"\n#EXTINF:4.000000,\n#EXT-X-BYTERANGE:10@2\nvideo.mp4\n#EXT-X-ENDLIST\n';
const probe={streams:[{codec_type:'video',width:1080,height:1920,avg_frame_rate:'30/1'},{codec_type:'audio'}],format:{duration:'4'}};
const original={id:MEDIA,type:'video/mp4',size:10,generation:'7'};
const level={id:'q360',width:360,height:640,bytes:12,generation:'9',bandwidth:1000,averageBandwidth:500,fps:30,codecs:'avc1.64001e,mp4a.40.2',playlist};
const data={pipeline:1,mediaId:MEDIA,sourceGeneration:'7',sourceSize:10,source:sourceInfo(probe),levels:[level],status:'ready'};
test('portrait and landscape ladders never upscale and support genuine vertical 4K',()=>{
    assert.deepEqual(qualityLevels({width:1080,height:1920}).map(v=>[v.width,v.height]),[[360,640],[720,1280],[1080,1920]]);
    assert.deepEqual(qualityLevels({width:2160,height:3840}).at(-1).id,'q2160');
    assert.deepEqual(qualityLevels({width:1920,height:1080}).at(0).height,360);
    assert.deepEqual(qualityLevels({width:240,height:426}).map(v=>v.id),['q240']);
    assert.equal(qualityLevels({width:0,height:0}).length,0);
});
test('rotation metadata is interpreted before generating portrait renditions',()=>{
    const value=sourceInfo({...probe,streams:[{...probe.streams[0],width:1920,height:1080,side_data_list:[{rotation:-90}]},probe.streams[1]]});
    assert.equal(value.width,1080);assert.equal(value.height,1920);
});
test('unsupported duration or HDR leaves originals available instead of incorrect renditions',()=>{
    assert.throws(()=>sourceInfo({...probe,format:{duration:'601'}}));
    assert.throws(()=>sourceInfo({...probe,streams:[{...probe.streams[0],color_transfer:'arib-std-b67'}]}));
});
test('HLS requires completed independent segments and bounded byte ranges',()=>{
    assert.equal(inspectPlaylist(playlist,12).duration,4);
    for(const invalid of [playlist.replace('#EXT-X-ENDLIST',''),playlist.replace('10@2','100@2'),playlist.replace('\nvideo.mp4\n','\n../../private.json\n')])assert.throws(()=>inspectPlaylist(invalid,12));
});
test('rendition records bind to the original generation and reject malformed or larger dimensions',()=>{
    assert.ok(validRenditions(data,original));
    assert.equal(validRenditions(data,{...original,generation:'8'}),null);
    assert.equal(validRenditions({...data,source:null},original),null);
    assert.equal(validRenditions({...data,levels:[{...level,width:2160,height:3840}]},original),null);
    assert.equal(validRenditions({...data,levels:[{...level,fps:NaN}]},original),null);
});
test('Auto master advertises actual dimensions/bitrates; child manifest uses signed storage ranges',()=>{
    const master=masterPlaylist(POST,MEDIA,data);
    assert.match(master,/RESOLUTION=360x640/);assert.match(master,/variant=q360/);assert.doesNotMatch(master,/2160/);
    const signed=signedPlaylist(level,'https://storage.googleapis.com/fixture/video.mp4?signature=test');
    assert.match(signed,/#EXT-X-BYTERANGE:10@2/);assert.equal(signed.split('signature=test').length-1,2);
    assert.throws(()=>signedPlaylist(level,'https://outside.example/private'));
});
test('feed decoration adds only public rendition metadata and keeps original media URL',async()=>{
    const post={id:POST,title:'Fixture',media:[original],publishAt:new Date(0).toISOString()};
    const decorate=decorateVideoPost(createRenditionReader({read:async()=>({data})}));
    const result=await decorate(post);
    assert.equal(result.media[0].variants[0].id,'adaptive');assert.equal(result.media[0].width,1080);
    assert.match(result.media[0].url,/newsMedia\?post=/);assert.doesNotMatch(JSON.stringify(result),/sourceGeneration|playlist|_news\/|generation/);
    const fallback=await decorateVideoPost(createRenditionReader({read:async()=>{throw Error('Storage unavailable');}}))(post);
    assert.equal(fallback.media[0].variants,undefined);
});
function delivery({status='published',sourceGeneration='7',assetGeneration='9',assetSize=12}={}){
    let signed=0;
    const handler=createNewsMediaHandler({catalog:async()=>({posts:[{id:POST,status,publishAt:new Date(0).toISOString(),media:[original]}]}),readUpload:async()=>null,previewSecret:()=>'',
        fileFor:()=>({getMetadata:async()=>[{size:'10',contentType:'video/mp4',generation:sourceGeneration}]}),
        readRenditions:async()=>data,
        fileForRendition:()=>({getMetadata:async()=>[{size:String(assetSize),contentType:'video/mp4',generation:assetGeneration}],getSignedUrl:async options=>{signed++;assert.equal(options.queryParams.generation,'9');return ['https://storage.googleapis.com/fixture/video.mp4?signature=test'];}})});
    return {get signed(){return signed;},async request(variant,method='GET'){
        const res={statusCode:200,headers:{},body:'',headersSent:false,set(k,v){if(typeof k==='object')Object.assign(this.headers,k);else this.headers[k]=v;return this;},status(c){this.statusCode=c;return this;},end(){this.headersSent=true;return this;},send(body){this.body=body;this.headersSent=true;return this;}};
        await handler({method,query:{post:POST,media:MEDIA,variant},headers:{}},res);return res;
    }};
}
test('public HLS uses existing publication checks; drafts and altered objects cannot yield signed URLs',async()=>{
    const good=delivery(),master=await good.request('adaptive'),child=await good.request('q360');
    assert.equal(master.statusCode,200);assert.equal(child.statusCode,200);assert.match(child.body,/#EXT-X-BYTERANGE/);assert.equal(good.signed,1);
    for(const opts of [{status:'draft'},{sourceGeneration:'8'},{assetGeneration:'10'},{assetSize:13}]){
        const f=delivery(opts),res=await f.request('q360');assert.equal(res.statusCode,404);assert.equal(f.signed,0);
    }
    assert.equal((await delivery().request('../../private')).statusCode,404);
    assert.equal((await delivery().request('q360','HEAD')).body,'');
});
test('processing triggers ignore tips, images, malformed jobs and generated stream assets',()=>{
    for(const name of ['tips/fixture/video.mp4','_news/v1/media/not-a-uuid',`_news/v1/streams/${MEDIA}/7/v1/q360.mp4`,`_news/v1/video-jobs/${MEDIA}/../../q360.json`])assert.equal(eventTarget({name,generation:'7',contentType:'video/mp4',size:10}),null);
    assert.equal(eventTarget({name:`_news/v1/media/${MEDIA}`,generation:'7',contentType:'image/jpeg',size:10}),null);
});
function storageFixture(){
    const rows=new Map();let generation=10;
    const put=(name,bytes,type='application/json',gen=String(++generation))=>rows.set(name,{bytes:Buffer.from(bytes),type,generation:gen});
    put(`_news/v1/uploads/${MEDIA}.json`,JSON.stringify({...original,generation:undefined}));put(`_news/v1/media/${MEDIA}`,'0123456789','video/mp4','7');
    const bucket={file(name,options={}){return {async getMetadata(){const r=rows.get(name);if(!r||(options.generation&&r.generation!==options.generation))throw {code:404};return [{generation:r.generation,size:String(r.bytes.length),contentType:r.type,md5Hash:createHash('md5').update(r.bytes).digest('base64')}];},async download(opts={}){await this.getMetadata();const bytes=rows.get(name).bytes;if(opts.destination)await writeFile(opts.destination,bytes);return [bytes];},async save(bytes,opts){const old=rows.get(name),expected=opts.preconditionOpts?.ifGenerationMatch;if(expected!==undefined&&String(expected)!==(old?.generation||'0'))throw {code:412};put(name,bytes,opts.contentType);},async getSignedUrl(){return ['https://storage.googleapis.com/fixture/source'];}};},async upload(path,options){if(rows.has(options.destination))throw {code:412};put(options.destination,await readFile(path),'video/mp4');}};
    return {bucket,rows};
}
test('new uploads queue each available tier once; rendition failure retries once and preserves originals',async()=>{
    const {bucket,rows}=storageFixture();let attempts=0;
    const process=createVideoProcessor({bucket,probe:async path=>{assert.equal((await readFile(path)).toString(),'0123456789');return probe;},encode:async({input,directory,level:choice})=>{
        assert.equal((await readFile(input)).toString(),'0123456789');
        if(++attempts===1)throw Error('Transient encode error');
        const file=join(directory,'video.mp4');await writeFile(file,'012345678901');return {...level,...choice,file};
    }});
    const source={name:`_news/v1/media/${MEDIA}`,generation:'7',contentType:'video/mp4',size:10};
    await process(source);await process(source);
    assert.equal([...rows.keys()].filter(k=>k.includes('/video-jobs/')).length,3);
    const event={name:`_news/v1/video-jobs/${MEDIA}/7/q360.json`,generation:'20'};
    await assert.rejects(process(event),/retry required/);
    assert.equal((await process(event)).status,'ready');assert.equal((await process(event)).status,'ready');assert.equal(attempts,2);
    assert.equal(rows.get(`_news/v1/media/${MEDIA}`).bytes.toString(),'0123456789');
    const index=JSON.parse(rows.get(`_news/v1/renditions/${MEDIA}/7.json`).bytes.toString());
    assert.equal(index.levels.length,1);assert.ok(validRenditions(index,original));
});
test('permanent failures stop after two attempts and transient probe errors can retry',async()=>{
    const {bucket,rows}=storageFixture();let tries=0,probes=0;
    const process=createVideoProcessor({bucket,probe:async()=>{if(++probes===1)throw Error('Network');return probe;},encode:async()=>{tries++;throw Error('Failure');}});
    const source={name:`_news/v1/media/${MEDIA}`,generation:'7',contentType:'video/mp4',size:10};
    await assert.rejects(process(source));await process(source);
    const event={name:`_news/v1/video-jobs/${MEDIA}/7/q360.json`,generation:'20'};
    await assert.rejects(process(event));assert.equal((await process(event)).status,'failed');assert.equal((await process(event)).status,'attempt-limit');assert.equal(tries,2);
    assert.ok(rows.has(`_news/v1/media/${MEDIA}`));
});

test('unreadable source probing stops after two attempts without touching the original',async()=>{
    const {bucket,rows}=storageFixture();let calls=0;
    const process=createVideoProcessor({bucket,probe:async()=>{calls++;throw Error('Unreadable source');}});
    const source={name:`_news/v1/media/${MEDIA}`,generation:'7',contentType:'video/mp4',size:10};
    await assert.rejects(process(source),/probe retry required/);
    assert.equal((await process(source)).status,'failed');
    assert.equal((await process(source)).status,'original-only');
    assert.equal(calls,2);assert.ok(rows.has(`_news/v1/media/${MEDIA}`));
});

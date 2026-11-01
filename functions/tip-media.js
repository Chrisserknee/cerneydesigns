'use strict';
// Incoming attachment previews are independent of finished report thumbnails.
const {createHash}=require('node:crypto');
const {GoogleAuth}=require('google-auth-library');
const {jpegDimensions}=require('./tip-thumbnail');
const {driveUrl}=require('./tip-alerts-helpers');
const MAX_BYTES=256*1024, ROOT='_tipalerts/v1/';
const sha=x=>createHash('sha256').update(x).digest('hex');
const ID=/^[a-f0-9]{64}$/;
const SOURCE=/^tips\/(?:submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}\/_submission\.json$/;
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/drive.readonly']});
function mediaDescriptor(tip){
    if(!tip || !ID.test(tip.id||'') || tip.status==='rejected')return null;
    const voice=tip.sourceKind==='google_voice';
    if(voice ? tip.path!==`${ROOT}voice-sources/${tip.id}.json` || !(tip.attachmentCount>0)
        : !SOURCE.test(tip.path||'') || sha(tip.path)!==tip.id || !driveUrl(tip.driveUrl))return null;
    const version=sha(JSON.stringify([tip.path,String(tip.sourceGeneration),voice?'':tip.driveUrl]));
    const summary=String(tip.mediaSummary||'');
    const kind=/videos?/.test(summary)?'video':/photos?/.test(summary)?'photo':'file';
    return {version,kind,count:Number.isSafeInteger(tip.attachmentCount)?Math.max(0,Math.min(100,tip.attachmentCount)):0};
}
function imageInfo(bytes){
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES)return null;
    const jpeg=jpegDimensions(bytes);
    const png=bytes.length>=33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        && bytes.toString('ascii',12,16)==='IHDR' ? {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}:null;
    const size=jpeg||png;
    if(!size || size.width<1 || size.height<1 || size.width>1024 || size.height>1024)return null;
    return {...size,mimeType:jpeg?'image/jpeg':'image/png',sizeBytes:bytes.length,sha256:sha(bytes)};
}
function thumbnailURL(value){
    try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')
        && (u.hostname==='googleusercontent.com'||u.hostname.endsWith('.googleusercontent.com'))?u:null;}catch{return null;}
}
async function fetchThumbnail(url,client){
    const u=thumbnailURL(url); if(!u)throw Error('Unsupported preview host');
    // Drive defaults to 220 pixels; 480 keeps an 84-point Retina crop crisp.
    u.pathname=u.pathname.replace(/=s[0-9]+$/, '=s480');
    // Use only Drive's short-lived URL. Never accept a caller URL or follow a credential redirect.
    const headers=await client.getRequestHeaders(u.href);
    const response=await fetch(u,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok || Number(response.headers.get('content-length')||0)>MAX_BYTES)throw Error('Preview unavailable');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES){await response.body.cancel().catch(()=>{});throw Error('Preview too large');}chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);if(!imageInfo(bytes))throw Error('Invalid preview');return bytes;
}
async function drivePreview(tip){
    const folder=new URL(tip.driveUrl).pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1];
    if(!folder)return null;
    const client=await auth.getClient();
    const result=await client.request({url:'https://www.googleapis.com/drive/v3/files',params:{
        q:`'${folder}' in parents and trashed = false`,pageSize:100,
        fields:'files(id,name,mimeType,thumbnailLink)'},timeout:15000});
    const media=(result.data.files||[]).filter(f=>/^(image|video)\//.test(f.mimeType||''));
    // Stable order keeps a card from switching images between refreshes.
    media.sort((a,b)=>String(a.name).localeCompare(String(b.name))||a.id.localeCompare(b.id));
    const count=media.length;
    for(const file of media.slice(0,3)){
        if(!file.thumbnailLink)continue;
        try{return {bytes:await fetchThumbnail(file.thumbnailLink,client),count,kind:file.mimeType.startsWith('video/')?'video':'photo'};}catch{/* another original may have a ready preview */}
    }
    return {count,kind:media.some(f=>f.mimeType.startsWith('video/'))?'video':count?'photo':'file'};
}
function createTipMedia({read,write,bucket,preview=drivePreview}){
    const inFlight=new Map();
    async function load(body){
        const tip=(await read(`tips/${body.id}.json`))?.data,descriptor=mediaDescriptor(tip);
        if(!descriptor || descriptor.version!==body.mediaVersion)return {media:null};
        const [source]=await bucket().file(tip.path).getMetadata();
        if(String(source.generation)!==String(tip.sourceGeneration) && tip.sourceKind!=='google_voice')return {media:null};
        if(source.metadata?.processingStatus==='rejected')return {media:null};
        let cached=await read(`media-previews/${tip.id}.json`),record=cached?.data;
        if(record?.version!==descriptor.version)record=null;
        if((!record?.image || record.renderVersion!==2) && tip.sourceKind!=='google_voice' && (!record?.retryAt || Date.parse(record.retryAt)<=Date.now())){
            let found;try{found=await preview(tip);}catch{/* transient upstream issue: retain the attachment indicator */}
            record={...descriptor,renderVersion:2,...(found?{count:found.count,kind:found.kind}:{}),retryAt:new Date(Date.now()+10*60000).toISOString()};
            if(found?.bytes){
                const info=imageInfo(found.bytes);
                if(info){
                    const name=`media-thumbnails/${tip.id}/${descriptor.version}-${info.sha256}.${info.mimeType==='image/jpeg'?'jpg':'png'}`;
                    const file=bucket().file(ROOT+name);
                    await file.save(found.bytes,{resumable:false,contentType:info.mimeType,metadata:{cacheControl:'no-store'}});
                    const [meta]=await file.getMetadata();
                    record.image={...info,name,generation:String(meta.generation)};
                }
            }
            try{await write(`media-previews/${tip.id}.json`,record,cached?.generation||0);}catch(e){if(e.code!==412)throw e;}
        }
        const output={...descriptor,...(record?{kind:record.kind,count:record.count}:{})};
        const image=record?.image;
        if(!image)return {media:output};
        if(!ID.test(image.sha256||'') || !/^\d+$/.test(String(image.generation))
            || !['jpg','png'].some(ext=>image.name===`media-thumbnails/${tip.id}/${descriptor.version}-${image.sha256}.${ext}`)
            || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes>MAX_BYTES)return {media:output};
        const file=bucket().file(ROOT+image.name,{generation:image.generation});
        const [meta]=await file.getMetadata();
        if(Number(meta.size)!==image.sizeBytes||meta.contentType!==image.mimeType)return {media:output};
        const [bytes]=await file.download(),info=imageInfo(bytes);
        if(!info||info.sha256!==image.sha256||info.width!==image.width||info.height!==image.height)return {media:output};
        const latest=mediaDescriptor((await read(`tips/${tip.id}.json`))?.data);
        if(latest?.version!==descriptor.version)return {media:null};
        return {media:{...output,image:{...info,base64:bytes.toString('base64')}}};
    }
    return async body=>{
        if(!ID.test(body.id||'')||!ID.test(body.mediaVersion||''))throw Object.assign(Error('Invalid media preview.'),{code:400});
        const key=body.id+body.mediaVersion;
        if(!inFlight.has(key))inFlight.set(key,load(body).finally(()=>inFlight.delete(key)));
        return inFlight.get(key);
    };
}
module.exports={mediaDescriptor,imageInfo,thumbnailURL,createTipMedia,MAX_BYTES};

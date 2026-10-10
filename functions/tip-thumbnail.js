'use strict';
const {createHash}=require('node:crypto');
const {driveUrl}=require('./tip-alerts-helpers');
const BUCKET='tip-line-8c2d7.firebasestorage.app';
const MAX_BYTES=256*1024;
const SOURCE=/^tips\/(?:submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}\/_submission\.json$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

// This descriptor is descriptive, never a public URL or storage capability.
function thumbnailDescriptor(tip,report){
    const t=report?.thumbnail;
    if(!tip || !report || report.version!==1 || !['ready','approved'].includes(report.state)
        || report.draftDelivered!==true || report.contextSource!=='claude'
        || !SOURCE.test(report.source||'') || report.id!==sha(report.source) || report.id!==tip.id
        || report.source!==tip.path || !/^\d+$/.test(String(report.sourceGeneration||''))
        || String(report.sourceGeneration)!==String(tip.sourceGeneration)
        || tip.status!=='ready' || !driveUrl(tip.driveUrl)
        || !integer(report.revision,1,10000) || !integer(report.contextVersion,0,10000)
        || !integer(report.planContextVersion,report.contextVersion,10000)
        || !t || t.version!==1 || t.mimeType!=='image/jpeg'
        || !integer(t.sizeBytes,4,MAX_BYTES) || !integer(t.width,1,1600) || !integer(t.height,1,900)
        || !/^[a-f0-9]{64}$/.test(t.sha256||'') || !/^[1-9]\d{0,29}$/.test(String(t.generation||''))
        || t.revision!==report.revision || t.contextVersion!==report.contextVersion) return null;
    if(tip.contextReceivedAt && (!report.sourceContextAt || !Number.isFinite(Date.parse(report.sourceContextAt))
        || Date.parse(report.sourceContextAt)<Date.parse(tip.contextReceivedAt)))return null;
    const jobId=sha(`${BUCKET}/${report.source}#${report.sourceGeneration}`).slice(0,20);
    if(t.jobId!==jobId || report.draftJobId!==jobId
        || t.name!==`_tipalerts/v1/thumbnails/${tip.id}/${jobId}/r${report.revision}-c${report.contextVersion}-${t.sha256}.jpg`)return null;
    return {version:1,generation:String(t.generation),sha256:t.sha256,revision:t.revision,
        contextVersion:t.contextVersion,width:t.width,height:t.height};
}

function requestedThumbnail(body){
    return /^[a-f0-9]{64}$/.test(body.id||'') && /^[a-f0-9]{64}$/.test(body.sha256||'')
        && /^[1-9]\d{0,29}$/.test(String(body.generation||''))
        && integer(body.revision,1,10000) && integer(body.contextVersion,0,10000);
}
function sameThumbnail(a,b){
    return a && b && a.sha256===b.sha256 && String(a.generation)===String(b.generation)
        && a.revision===b.revision && a.contextVersion===b.contextVersion;
}

function jpegDimensions(bytes){
    if(bytes.length<4 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes.at(-2)!==0xff || bytes.at(-1)!==0xd9)return null;
    let offset=2;
    while(offset<bytes.length-2){
        if(bytes[offset++]!==0xff)return null;
        while(bytes[offset]===0xff)offset++;
        const marker=bytes[offset++];
        if(marker===0xda || marker===0xd9)return null;
        if(marker===0x01 || (marker>=0xd0&&marker<=0xd7))continue;
        if(offset+2>bytes.length)return null;
        const length=bytes.readUInt16BE(offset);
        if(length<2 || offset+length>bytes.length)return null;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
            if(length<8)return null;
            return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};
        }
        offset+=length;
    }
    return null;
}
function verifiedThumbnailBytes(bytes,thumbnail){
    if(!Buffer.isBuffer(bytes) || bytes.length>MAX_BYTES || bytes.length!==thumbnail.sizeBytes || sha(bytes)!==thumbnail.sha256)return false;
    const size=jpegDimensions(bytes);
    return !!size && size.width===thumbnail.width && size.height===thumbnail.height;
}
module.exports={thumbnailDescriptor,requestedThumbnail,sameThumbnail,verifiedThumbnailBytes,MAX_BYTES};

'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=256*1024;
function jpegSize(bytes){
 if(bytes.length<4 || bytes[0]!==255 || bytes[1]!==216 || bytes.at(-2)!==255 || bytes.at(-1)!==217)throw Error('INVALID_JPEG');
 let i=2;
 while(i+3<bytes.length){
  if(bytes[i++]!==255)throw Error('INVALID_JPEG');
  while(bytes[i]===255)i++;
  const marker=bytes[i++];
  if(marker===217 || marker===218)break;
  if(marker===1 || (marker>=208 && marker<=215))continue;
  const length=bytes.readUInt16BE(i);
  if(length<2 || i+length>bytes.length)throw Error('INVALID_JPEG');
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
   if(length<8)throw Error('INVALID_JPEG');
   return {height:bytes.readUInt16BE(i+3),width:bytes.readUInt16BE(i+5)};
  }
  i+=length;
 }
 throw Error('INVALID_JPEG');
}
function loadThumbnail(item,input,cfg){
 const t=item.thumbnail;
 if(t===null || t===undefined)return null;
 const jobId=crypto.createHash('sha256').update(`${cfg.bucket}/${item.source}#${item.sourceGeneration}`).digest('hex').slice(0,20);
 const validInt=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
 if(!['ready','approved'].includes(item.state) || item.draftDelivered!==true ||
    !validInt(item.revision,1,10000) || !validInt(item.contextVersion,0,10000) ||
    !validInt(item.planContextVersion,item.contextVersion,10000) || item.draftJobId!==jobId ||
    t.version!==1 || t.jobId!==jobId || t.revision!==item.revision || t.contextVersion!==item.contextVersion ||
    t.mimeType!=='image/jpeg' || !/^[a-f0-9]{64}$/.test(t.sha256 || '') ||
    !validInt(t.width,1,1600) || !validInt(t.height,1,900) || !validInt(t.sizeBytes,1,MAX_BYTES))throw Error('INVALID_THUMBNAIL');
 const name=`_tipalerts/v1/thumbnails/${item.id}/${jobId}/r${item.revision}-c${item.contextVersion}-${t.sha256}.jpg`;
 if(t.name!==name)throw Error('INVALID_THUMBNAIL_PATH');
 const folder=path.join(fs.realpathSync(input.stateDir),'thumbnails');
 if(fs.lstatSync(folder).isSymbolicLink())throw Error('INVALID_THUMBNAIL_PATH');
 const file=input.thumbnailFiles?.[item.id];
 if(typeof file!=='string' || !path.isAbsolute(file) || path.dirname(fs.realpathSync(file))!==folder || fs.lstatSync(file).isSymbolicLink())throw Error('INVALID_THUMBNAIL_PATH');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let bytes;
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile() || stat.size!==t.sizeBytes || stat.size>MAX_BYTES)throw Error('INVALID_THUMBNAIL_SIZE');
  bytes=fs.readFileSync(fd);
 }finally{fs.closeSync(fd);}
 if(bytes.length!==t.sizeBytes || bytes.length>MAX_BYTES || crypto.createHash('sha256').update(bytes).digest('hex')!==t.sha256)throw Error('INVALID_THUMBNAIL_HASH');
 const size=jpegSize(bytes);
 if(size.width!==t.width || size.height!==t.height)throw Error('INVALID_THUMBNAIL_DIMENSIONS');
 return {bytes,thumbnail:t,md5Hash:crypto.createHash('md5').update(bytes).digest('base64')};
}
async function publishThumbnail(item,input,cfg,request){
 const checked=loadThumbnail(item,input,cfg);
 if(!checked)return null;
 const {bytes,thumbnail:t,md5Hash}=checked;
 const base=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o/${encodeURIComponent(t.name)}`;
 let response=await request(base),metadata;
 if(response.status===404){
  const boundary='thumbnail-'+crypto.randomBytes(12).toString('hex');
  const meta={name:t.name,contentType:'image/jpeg',cacheControl:'no-store',metadata:{sha256:t.sha256,tipId:item.id,jobId:t.jobId,sourceGeneration:item.sourceGeneration,revision:String(t.revision),contextVersion:String(t.contextVersion)}};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--`)]);
  response=await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=multipart&ifGenerationMatch=0`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  if(response.status===412)response=await request(base);
 }
 if(!response.ok)throw Error('THUMBNAIL_UPLOAD_FAILED');
 metadata=await response.json();
 if(metadata.name!==t.name || metadata.contentType!=='image/jpeg' || metadata.cacheControl!=='no-store' ||
    String(metadata.size)!==String(bytes.length) || metadata.md5Hash!==md5Hash || metadata.metadata?.sha256!==t.sha256 ||
    metadata.metadata?.tipId!==item.id || metadata.metadata?.jobId!==t.jobId || metadata.metadata?.sourceGeneration!==item.sourceGeneration ||
    !/^\d+$/.test(String(metadata.generation)))throw Error('THUMBNAIL_UPLOAD_UNVERIFIED');
 return {...t,generation:String(metadata.generation)};
}
module.exports={MAX_BYTES,jpegSize,loadThumbnail,publishThumbnail};

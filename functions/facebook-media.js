'use strict';
const {createHash}=require('node:crypto');
const id=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const error=(message,code=400)=>Object.assign(new Error(message),{code});
const GROUP='1416333486418080', PART_BYTES=1024*1024, MAX_BYTES=200*1024*1024;
const TYPES=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']);
function facebookURL(value){
 try{const u=new URL(value);return u.protocol==='https:'&&['www.facebook.com','facebook.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port?u.href:null;}catch{return null;}
}
function inGroup(value){try{return new URL(facebookURL(value)).pathname.startsWith('/groups/'+GROUP+'/');}catch{return false;}}
function manifest(value,reportID,sources){
 if(!value||value.version!==1||value.reportID!==reportID||!Array.isArray(value.assets)||value.assets.length>12)throw error('Invalid Facebook media manifest.');
 return value.assets.map(a=>{
  if(!a||!id(a.id)||!id(a.sha256)||!TYPES.has(a.mimeType)||!Number.isSafeInteger(a.bytes)||a.bytes<=0||a.bytes>MAX_BYTES||!Array.isArray(a.parts)||a.parts.length<1||a.parts.length>200||!['original','source_screenshot'].includes(a.origin)||!facebookURL(a.sourceURL)||!sources.includes(a.sourceURL))throw error('Invalid Facebook attachment.');
  let bytes=0;
  const parts=a.parts.map(p=>{if(!p||!id(p.sha256)||!Number.isSafeInteger(p.bytes)||p.bytes<=0||p.bytes>PART_BYTES)throw error('Invalid Facebook media part.');bytes+=p.bytes;return {sha256:p.sha256,bytes:p.bytes};});
  if(bytes!==a.bytes||typeof a.filename!=='string'||!a.filename||a.filename.length>180||/[\x00-\x1f/\\]/.test(a.filename))throw error('Invalid Facebook media size or name.');
  return {id:a.id,filename:a.filename,mimeType:a.mimeType,bytes:a.bytes,sha256:a.sha256,parts,sourceURL:a.sourceURL,origin:a.origin};
 });
}
function createFacebookMedia({read,bucket,root}){
 return async body=>{
  if(!id(body.id))throw error('Invalid Facebook report.');
  const report=(await read('research/'+body.id+'.json'))?.data;
  const sources=(report?.sources||[]).map(s=>s.url);
  if(!sources.some(inGroup))throw error('Facebook report not found.',404);
  const stored=(await read('facebook-media/'+body.id+'/manifest.json'))?.data;
  const assets=stored?manifest(stored,body.id,sources):[];
  if(body.op==='facebook-media-list')return {assets};
  if(body.op!=='facebook-media-read'||!id(body.assetID)||!Number.isInteger(body.index)||body.index<0)throw error('Invalid media request.');
  const asset=assets.find(a=>a.id===body.assetID),part=asset?.parts[body.index];
  if(!part)throw error('Attachment not found.',404);
  const path=`${root}facebook-media/${body.id}/${asset.id}/${body.index}-${part.sha256}`;
  const [meta]=await bucket().file(path).getMetadata();
  if(Number(meta.size)!==part.bytes)throw error('Attachment size changed.',409);
  const [bytes]=await bucket().file(path,{generation:meta.generation}).download();
  if(bytes.length!==part.bytes||createHash('sha256').update(bytes).digest('hex')!==part.sha256)throw error('Attachment integrity check failed.',409);
  return {base64:bytes.toString('base64'),sha256:part.sha256};
 };
}
module.exports={createFacebookMedia,manifest,inGroup,PART_BYTES};

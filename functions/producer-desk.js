'use strict';
const {createHash}=require('node:crypto');
const ID=/^[a-f0-9]{64}$/;
const STATES=['queued','received','working','needs_answer','rendering','ready','failed','cancelled'];
const CATALOG={version:1,formats:[{id:'footage',label:'Footage-led report'},{id:'field',label:'Reporter in the field'},{id:'explainer',label:'Statement explainer'},{id:'community',label:'Community feature'}],banners:[{id:'slate',label:'Slate glass'},{id:'gray',label:'Gray frosted'},{id:'blue',label:'Classic blue'},{id:'red',label:'Urgent red'}],lengths:[{id:'short',label:'About 30 seconds'},{id:'standard',label:'About 60 seconds'},{id:'source',label:'Let the reporting decide'}]};
const error=(message,code=400)=>Object.assign(Error(message),{code});
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const validID=value=>typeof value==='string'&&ID.test(value);
function text(value,max,name,required=true){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw error(`${name} must contain ${required?'1':'0'} to ${max} characters.`);return value.trim();}
function preferences(value={}){
 const out={};for(const [key,options] of [['format',CATALOG.formats],['banner',CATALOG.banners],['length',CATALOG.lengths]]){if(!options.some(x=>x.id===value[key]))throw error('Choose a supported report style.');out[key]=value[key];}
 for(const key of ['captions','originalAudio','noMusic']){if(typeof value[key]!=='boolean')throw error('Choose the audio and caption settings.');out[key]=value[key];}
 return out;
}
function sourceRefs(value){if(!Array.isArray(value)||value.length>12)throw error('Attach up to 12 saved sources.');const seen=new Set();return value.map(x=>{if(!x||!['tip','note','research'].includes(x.kind)||!validID(x.id))throw error('Invalid attached source.');const key=x.kind+':'+x.id;if(seen.has(key))throw error('The same source is attached twice.');seen.add(key);return {kind:x.kind,id:x.id};});}
function threadSummary(t){return {id:t.id,title:t.title,revision:t.revision,createdAt:t.createdAt,updatedAt:t.updatedAt,status:t.commands?.at(-1)?.status||'queued',pending:(t.commands||[]).filter(x=>['queued','received','working','rendering'].includes(x.status)).length,lastReply:t.commands?.at(-1)?.reply?.text?.slice(0,200)||null};}
function threadMetadata(t){const s=threadSummary(t);return Object.fromEntries(Object.entries({producerIndex:'1',...s,pending:String(s.pending),revision:String(s.revision),lastReply:s.lastReply||''}).map(([k,v])=>[k,String(v)]));}
function publicThread(t){if(!t)return null;return {...threadSummary(t),preferences:t.preferences,sourceRefs:t.sourceRefs,assets:t.assets||[],commands:(t.commands||[]).map(({id,text,createdAt,status,receivedAt,startedAt,completedAt,reply,error,preferences,sourceRefs,assetIDs})=>({id,text,createdAt,status,receivedAt,startedAt,completedAt,reply,error,preferences,sourceRefs,assetIDs}))};}
function normalizeRequest(body){
 if(!validID(body.id)||!validID(body.requestID))throw error('Invalid request identifier.');
 const message=text(body.text,4000,'Your message'),style=preferences(body.preferences),refs=sourceRefs(body.sourceRefs||[]);
 const assets=body.assetIDs||[];if(!Array.isArray(assets)||assets.length>20||!assets.every(validID)||new Set(assets).size!==assets.length)throw error('Invalid media selection.');
 return {id:body.requestID,text:message,preferences:style,sourceRefs:refs,assetIDs:assets};
}
function createProducerDesk({read,write,list,bucket,root,clock=()=>new Date().toISOString()}){
 return async function handle(body,device){
  if(body.op==='producer-catalog')return {catalog:CATALOG,deviceScope:sha(device.id)};
  if(body.op==='producer-list'){if(body.cursor!==undefined&&(typeof body.cursor!=='string'||body.cursor.length>4000))throw error('Invalid page.');const [page,health]=await Promise.all([list(body.cursor),read('producer-monitor/status.json')]);return {...page,health:health?.data||null};}
  if(!validID(body.id))throw error('Invalid story identifier.');
  const name=`producer-threads/${body.id}.json`;
  if(body.op==='producer-get')return {thread:publicThread((await read(name))?.data)};
  if(body.op==='producer-send'){
   const request=normalizeRequest(body),fingerprint=sha(request);
   for(let attempt=0;attempt<5;attempt++){
    const stored=await read(name),t=stored?.data,existing=t?.commands?.find(x=>x.id===request.id);
    if(existing){if(existing.fingerprint!==fingerprint)throw error('This request identifier already belongs to a different message.',409);return {thread:publicThread(t),duplicate:true};}
    if(t&&(t.commands||[]).length>=60)throw error('This conversation is full. Start another story workspace; the original remains saved.');
    if(t&&(t.commands||[]).filter(x=>['queued','received','working','rendering'].includes(x.status)).length>=5)throw error('Five instructions are already waiting. Let the Mac finish before adding more.',429);
    if(request.assetIDs.some(id=>!t?.assets?.some(a=>a.id===id)))throw error('Finish attaching the selected media first.');
    const resolved=[];for(const ref of request.sourceRefs){const snapshot=`producer-sources/${body.id}/${request.id}/${ref.kind}-${ref.id}.json`;let frozen=await read(snapshot);if(!frozen){const prefix={tip:'tips',note:'field-notes',research:'research'}[ref.kind],source=await read(`${prefix}/${ref.id}.json`);if(!source)throw error('An attached source is no longer available. Reopen it before sending.',409);try{await write(snapshot,{source:source.data,generation:String(source.generation)},0);}catch(e){if(e.code!==412)throw e;}frozen=await read(snapshot);}resolved.push({...ref,generation:frozen.data.generation,snapshot});}
    const at=clock(),next=t?{...t}:{version:1,id:body.id,title:text(body.title||'New report',180,'Story title'),createdAt:at,revision:0,commands:[],assets:[]};
    next.revision++;next.updatedAt=at;next.preferences=request.preferences;next.sourceRefs=resolved;
    next.commands=[...(next.commands||[]),{...request,sourceRefs:resolved,fingerprint,status:'queued',createdAt:at,submittedBy:device.id,attempts:0}];
    try{await write(name,next,stored?.generation||0);return {thread:publicThread(next),duplicate:false};}catch(e){if(e.code!==412||attempt===4)throw e;}
   }
  }
  if(body.op==='producer-cancel'){
   if(!validID(body.requestID))throw error('Invalid instruction.');
   for(let attempt=0;attempt<5;attempt++){
    const stored=await read(name);if(!stored)throw error('Story not found.',404);
    const t=stored.data,c=t.commands.find(x=>x.id===body.requestID);if(!c)throw error('Instruction not found.',404);
    if(c.status==='cancelled')return {thread:publicThread(t)};
    if(c.status!=='queued')throw error('The Mac has already received this instruction. Send a follow-up to change direction.',409);
    c.status='cancelled';c.completedAt=clock();t.updatedAt=clock();t.revision++;
    try{await write(name,t,stored.generation);return {thread:publicThread(t)};}catch(e){if(e.code!==412||attempt===4)throw e;}
   }
  }
  if(body.op==='producer-media-part'){
   if(!validID(body.assetID)||!validID(body.sha256)||!Number.isInteger(body.index)||body.index<0||body.index>=192||typeof body.base64!=='string'||body.base64.length>710000)throw error('Invalid media part.');
   const bytes=Buffer.from(body.base64,'base64');if(!bytes.length||bytes.length>512*1024||sha(bytes)!==body.sha256)throw error('Media checksum mismatch.');
   const f=bucket().file(`${root}producer-media/${body.id}/${body.assetID}/parts/${body.index}-${body.sha256}`);
   try{await f.save(bytes,{resumable:false,contentType:'application/octet-stream',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:0}});}catch(e){if(e.code!==412)throw e;}
   return {accepted:true,index:body.index};
  }
  if(body.op==='producer-media-finish'){
   if(!validID(body.assetID)||!validID(body.sha256)||!Array.isArray(body.parts)||!body.parts.length||body.parts.length>192||!body.parts.every(validID))throw error('Invalid media manifest.');
   const filename=text(body.filename,180,'Filename');if(/[\\/\x00-\x1f]/.test(filename))throw error('Use a plain filename.');
   if(!['video/mp4','video/quicktime','image/jpeg','image/png','image/webp','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','application/pdf'].includes(body.mimeType))throw error('Attach a video, image, audio recording, or PDF.');
   let bytes=0;for(let start=0;start<body.parts.length;start+=12){const checked=await Promise.allSettled(body.parts.slice(start,start+12).map(async(h,j)=>{const [meta]=await bucket().file(`${root}producer-media/${body.id}/${body.assetID}/parts/${start+j}-${h}`).getMetadata();const size=Number(meta.size);if(!Number.isInteger(size)||size<1||size>512*1024)throw error('Media part is incomplete.');return size;}));for(const result of checked){if(result.status==='rejected')throw result.reason;bytes+=result.value;}}
   if(bytes!==body.bytes||bytes>96*1024*1024)throw error('Media size mismatch.');
   const asset={id:body.assetID,filename,mimeType:body.mimeType,sha256:body.sha256,parts:body.parts,bytes,savedAt:clock(),verification:'Mac checksum and format verification pending'};
   for(let attempt=0;attempt<5;attempt++){
    const stored=await read(name),t=stored?.data||{version:1,id:body.id,title:text(body.title||'New report',180,'Story title'),createdAt:clock(),revision:0,commands:[],assets:[]};
    const old=t.assets.find(x=>x.id===asset.id);if(old){if(old.sha256!==asset.sha256)throw error('This attachment already holds a different original.',409);return {thread:publicThread(t),asset:old};}
    if(t.assets.length>=20)throw error('Attach up to 20 files to one story.');
    t.assets.push(asset);t.revision++;t.updatedAt=clock();
    try{await write(name,t,stored?.generation||0);return {thread:publicThread(t),asset};}catch(e){if(e.code!==412||attempt===4)throw e;}
   }
  }
  if(body.op==='producer-artifact'){
   if(!validID(body.requestID)||!validID(body.artifactID)||!Number.isInteger(body.index)||body.index<0)throw error('Invalid review file.');
   const t=(await read(name))?.data,c=t?.commands?.find(x=>x.id===body.requestID),a=c?.reply?.artifacts?.find(x=>x.id===body.artifactID);
   if(!a||!Array.isArray(a.parts)||body.index>=a.parts.length)throw error('Review file unavailable.',404);
   const part=a.parts[body.index];if(!validID(part))throw error('Review file manifest is invalid.');
   const [data]=await bucket().file(`${root}producer-output/${body.id}/${body.requestID}/${a.id}/parts/${body.index}-${part}`).download();
   if(data.length>512*1024||sha(data)!==part)throw error('Review file checksum mismatch.');
   return {base64:data.toString('base64'),sha256:part,mimeType:a.mimeType,total:a.parts.length};
  }
  throw error('Unknown Producer Desk operation.');
 };
}
module.exports={createProducerDesk,CATALOG,STATES,preferences,sourceRefs,threadSummary,threadMetadata,publicThread,normalizeRequest,sha,validID};

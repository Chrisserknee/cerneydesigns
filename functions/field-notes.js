'use strict';
const {fieldNote,id,digest}=require('./newsroom-record');
const MAX_CHUNK=512*1024,MAX_PARTS=64;
function createFieldNotes({read,write,bucket,root}){
 return async function handle(body){
  if(!id(body.id))throw Object.assign(Error('Invalid note'),{code:400});
  const name=`field-notes/${body.id}.json`, current=await read(name);
  if(body.op==='field-get')return {note:current?.data||null};
  if(body.op==='field-save'){
   const value=fieldNote({...body.note,id:body.id});
   for(const key of ['evidence','markers','kind'])if(body.note?.[key]===undefined&&current?.data[key])value[key]=current.data[key];
   if(current&&current.data.revision>=value.revision){
    if(current.data.revision===value.revision&&['title','transcript','draft','notes','processRequested','duration','kind','relatedIDs','evidence','markers'].every(k=>JSON.stringify(current.data[k]??(k==='kind'?'recording':['relatedIDs','evidence','markers'].includes(k)?[]:null))===JSON.stringify(value[k]??null)))return {note:current.data};
    throw Object.assign(Error('A newer note is saved. Refresh before editing.'),{code:409});
   }
   if(body.expectedRevision!==undefined&&body.expectedRevision!==(current?.data.revision||0))throw Object.assign(Error('This recording changed on another device. Refresh before editing; your local draft is still saved.'),{code:409});
   const saved={...value,createdAt:current?.data.createdAt||value.createdAt,audio:current?.data.audio||null};
   await write(name,saved,current?.generation||0);return {note:saved};
  }
  if(!current)throw Object.assign(Error('Save the note first'),{code:400});
  if(body.op==='field-audio-read'){
   const parts=current.data.audio?.parts;
   if(!parts||!Number.isInteger(body.index)||body.index<0||body.index>=parts.length)throw Object.assign(Error('Invalid recording part'),{code:400});
   const sha=parts[body.index];const [bytes]=await bucket().file(`${root}field-audio/${body.id}/parts/${body.index}-${sha}`).download();
   if(digest(bytes)!==sha)throw Error('Recording checksum mismatch');
   return {base64:bytes.toString('base64'),sha256:sha,total:parts.length,mimeType:current.data.audio.mimeType||'audio/mp4'};
  }
  if(body.op==='field-audio-part'){
   if(!Number.isInteger(body.index)||body.index<0||body.index>=MAX_PARTS||!id(body.sha256)||typeof body.base64!=='string'||body.base64.length>MAX_CHUNK*1.4)throw Object.assign(Error('Invalid recording part'),{code:400});
   const bytes=Buffer.from(body.base64,'base64');if(!bytes.length||bytes.length>MAX_CHUNK||digest(bytes)!==body.sha256)throw Object.assign(Error('Recording checksum mismatch'),{code:400});
   // Content-addressed chunks are immutable and safe to retry after a timeout.
   const file=bucket().file(`${root}field-audio/${body.id}/parts/${body.index}-${body.sha256}`);
   try{await file.save(bytes,{resumable:false,contentType:'application/octet-stream',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:0}});}catch(e){if(e.code!==412)throw e;}
   return {accepted:true,index:body.index};
  }
  if(body.op==='field-audio-finish'){
   if(!Array.isArray(body.parts)||!body.parts.length||body.parts.length>MAX_PARTS||!body.parts.every(id)||!id(body.sha256))throw Object.assign(Error('Invalid recording manifest'),{code:400});
   if(current.data.audio?.sha256===body.sha256)return {saved:true,audio:current.data.audio};
   if(current.data.audio)throw Object.assign(Error('Original recording is already saved'),{code:409});
   const chunks=[];for(const [i,sha] of body.parts.entries()){
    const [bytes]=await bucket().file(`${root}field-audio/${body.id}/parts/${i}-${sha}`).download();
    if(bytes.length>MAX_CHUNK||digest(bytes)!==sha)throw Error('Recording part changed');chunks.push(bytes);
   }
   const bytes=Buffer.concat(chunks);if(digest(bytes)!==body.sha256)throw Object.assign(Error('Recording checksum mismatch'),{code:400});
   const mimeType=body.mimeType==='audio/webm'?'audio/webm':'audio/mp4';
   const path=`${root}field-audio/${body.id}/original.${mimeType==='audio/webm'?'webm':'m4a'}`;
   try{await bucket().file(path).save(bytes,{resumable:false,contentType:mimeType,metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:0}});}catch(e){if(e.code!==412)throw e;const [old]=await bucket().file(path).download();if(digest(old)!==body.sha256)throw Object.assign(Error('Different recording already exists'),{code:409});}
   const audio={mimeType,sha256:body.sha256,bytes:bytes.length,parts:body.parts,savedAt:new Date().toISOString()};
   const fresh=await read(name);await write(name,{...fresh.data,audio},fresh.generation);return {saved:true,audio};
  }
  throw Object.assign(Error('Unknown note operation'),{code:400});
 };
}
module.exports={createFieldNotes,MAX_CHUNK};

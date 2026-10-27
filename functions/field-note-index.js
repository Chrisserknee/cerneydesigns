'use strict';
const {id}=require('./newsroom-record');
function noteMetadata(note){
 if(!note||!id(note.id)||!Number.isSafeInteger(note.revision)||note.revision<1)return null;
 return {cerneyFieldNoteVersion:'1',noteID:note.id,title:String(note.title||'Field recording').slice(0,180),revision:String(note.revision),createdAt:String(note.createdAt||''),updatedAt:String(note.updatedAt||note.createdAt||''),hasAudio:note.audio?'true':'false',processRequested:note.processRequested?'true':'false',nextRetryAt:String(note.nextRetryAt||''),duration:String(Number(note.duration)||0),kind:note.kind==='notebook'?'notebook':'recording',sourceIDs:JSON.stringify([...new Set((Array.isArray(note.evidence)?note.evidence:[]).map(e=>e?.id).filter(id))].slice(0,30))};
}
function noteSummary(metadata,expectedID){
 const m=metadata?.metadata||metadata;
 if(!m||m.cerneyFieldNoteVersion!=='1'||!id(m.noteID)||m.noteID!==expectedID||!/^\d+$/.test(m.revision||'')||!Number.isSafeInteger(Number(m.revision))||Number(m.revision)<1||!Number.isFinite(Date.parse(m.createdAt)))return null;
 let sourceIDs;
 try{const values=JSON.parse(m.sourceIDs);if(Array.isArray(values)&&values.length<=30&&values.every(id))sourceIDs=[...new Set(values)];}catch{}
 return {id:m.noteID,title:String(m.title||'Field recording').slice(0,180),revision:Number(m.revision),createdAt:m.createdAt,updatedAt:m.updatedAt||m.createdAt,hasAudio:m.hasAudio==='true',kind:['notebook','recording'].includes(m.kind)?m.kind:undefined,sourceIDs};
}
module.exports={noteMetadata,noteSummary};

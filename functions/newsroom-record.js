'use strict';
const {createHash}=require('node:crypto');
const {evidenceContext,dismissedIDs}=require('./evidence-context');
const id=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const clean=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
function sourceURL(x){try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:null;}catch{return null;}}
function researchRecord(x){
 if(!x||x.version!==1||!id(x.id)||!Number.isInteger(x.revision)||x.revision<1||!Number.isFinite(Date.parse(x.observedAt)))return null;
 const kind=['facebook_group','email','official_email','public_page','official_statement'].includes(x.kind)?x.kind:'research';
 const sources=(Array.isArray(x.sources)?x.sources:[]).slice(0,30).map(s=>({label:clean(s.label,240),url:sourceURL(s.url),kind:clean(s.kind,40),excerpt:clean(s.excerpt,6000),publishedAt:clean(s.publishedAt,40)}));
 if(!clean(x.title,240)||!clean(x.summary,6000)||!sources.length)return null;
 return {version:1,id:x.id,revision:x.revision,kind,title:clean(x.title,240),summary:clean(x.summary,6000),whatChanged:clean(x.whatChanged,3000),location:clean(x.location,500),observedAt:x.observedAt,eventAt:Number.isFinite(Date.parse(x.eventAt))?x.eventAt:null,timeLabel:clean(x.timeLabel,600)||'Event time unconfirmed',priority:['urgent','important'].includes(x.priority)?x.priority:'routine',verification:'Source report · needs verification',sources,questions:(Array.isArray(x.questions)?x.questions:[]).filter(s=>typeof s==='string').slice(0,20).map(s=>clean(s,1000)),contradictions:(Array.isArray(x.contradictions)?x.contradictions:[]).filter(s=>typeof s==='string').slice(0,20).map(s=>clean(s,1000)),relatedJobIDs:(Array.isArray(x.relatedJobIDs)?x.relatedJobIDs:[]).filter(s=>/^[a-f0-9]{20}$/.test(s)),notify:x.notify===true,createdAt:x.createdAt||x.observedAt};
}
function fieldNote(x){
 if(!x||!id(x.id)||!Number.isInteger(x.revision)||x.revision<1)throw Object.assign(Error('Invalid note'),{code:400});
 if(typeof x.title==='string'&&x.title.length>180)throw Object.assign(Error('Keep the story title under 180 characters. Your local edits are preserved.'),{code:400});
 if(typeof x.notes==='string'&&x.notes.length>15000)throw Object.assign(Error('Keep reporting notes under 15,000 characters or split them into another notebook. Your local edits are preserved.'),{code:400});
 if(typeof x.transcript!=='string'||x.transcript.length>100000||typeof x.draft!=='string'||x.draft.length>30000)throw Object.assign(Error('Note too long'),{code:400});
 return {version:1,id:x.id,revision:x.revision,kind:x.kind==='notebook'?'notebook':'recording',processRequested:x.processRequested===true,processingStatus:x.processRequested===true?"Queued for transcription / story development":"Saved",title:clean(x.title,180)||'Field recording',createdAt:Number.isFinite(Date.parse(x.createdAt))?x.createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),transcript:x.transcript,draft:x.draft,notes:clean(x.notes,15000),duration:Math.max(0,Math.min(3600,Number(x.duration)||0)),relatedIDs:(Array.isArray(x.relatedIDs)?x.relatedIDs:[]).filter(id).slice(0,20),evidence:(Array.isArray(x.evidence)?x.evidence:[]).slice(0,30).filter(e=>e&&id(e.id)).map(e=>({id:e.id,title:clean(e.title,240),excerpt:clean(e.excerpt,6000),url:sourceURL(e.url),kind:clean(e.kind,40),receivedAt:clean(e.receivedAt,40),...(e.context?{context:evidenceContext(e.context)}:{})})),dismissedEvidenceIDs:dismissedIDs(x.dismissedEvidenceIDs),markers:(Array.isArray(x.markers)?x.markers:[]).slice(0,100).filter(m=>m&&typeof m.id==='string'&&m.id.length<=64&&Number.isFinite(m.seconds)&&m.seconds>=0&&m.seconds<=3600).map(m=>({id:m.id,seconds:m.seconds,label:clean(m.label,200)||'Marker'}))};
}
const digest=b=>createHash('sha256').update(b).digest('hex');
module.exports={id,clean,sourceURL,researchRecord,fieldNote,digest};

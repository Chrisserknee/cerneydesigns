'use strict';
// Optional metadata from already-imported evidence. This module has no provider
// clients or network access; it never determines that a claim is verified.
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
function evidenceContext(x){
 if(!x||typeof x!=='object'||Array.isArray(x))return undefined;
 const out={};
 if(text(x.location,500))out.location=text(x.location,500);
 if(typeof x.eventAt==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(x.eventAt)&&Number.isFinite(Date.parse(x.eventAt)))out.eventAt=new Date(x.eventAt).toISOString();
 for(const k of ['textFingerprint','mediaFingerprint'])if(hash(x[k]))out[k]=x[k];
 for(const k of ['questions','contradictions'])if(Array.isArray(x[k]))out[k]=[...new Set(x[k].filter(v=>typeof v==='string').map(v=>text(v,1000)).filter(Boolean))].slice(0,20);
 return out;
}
function dismissedIDs(x){return [...new Set((Array.isArray(x)?x:[]).filter(hash))].slice(-200);}
function preserveEvidenceContext(incoming,current){
 const input={...incoming};
 if(input.dismissedEvidenceIDs===undefined&&current?.dismissedEvidenceIDs)input.dismissedEvidenceIDs=current.dismissedEvidenceIDs;
 if(Array.isArray(input.evidence)){
  const previous=new Map((current?.evidence||[]).map(e=>[e.id,e]));
  input.evidence=input.evidence.map(e=>e&&e.context===undefined&&previous.get(e.id)?.context?{...e,context:previous.get(e.id).context}:e);
 }
 return input;
}
module.exports={evidenceContext,dismissedIDs,preserveEvidenceContext};

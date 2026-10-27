(function(root){
 'use strict';
 const validID=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const sourceLabel=a=>a.kind==='facebook_group'?'Facebook alert':a.kind==='official_email'?'Official email':String(a.kind).includes('email')?'Email lead':a.kind==='official_statement'?'Official statement':'Source alert';
 const excerpt=(value,limit)=>{const s=String(value||'');return s.length<=limit?s:s.slice(0,limit-48)+'\n[Excerpt shortened; review the original source.]';};
 function evidence(alert){
  const context=[`Reported location: ${excerpt(alert.location||'Unconfirmed',500)}`,`Event timing: ${excerpt(alert.timeLabel||'Unconfirmed',600)}`,`Source observed: ${alert.observedAt||'Unknown'} (not the event time)`,`Verification: ${excerpt(alert.verification||'Source claim · needs verification',200)}`,excerpt(alert.summary,1400)];
  if(alert.whatChanged)context.push('What changed: '+excerpt(alert.whatChanged,400));
  if(alert.contradictions?.length)context.push('Conflicting accounts:\n'+excerpt(alert.contradictions.join('\n'),700));
  if(alert.questions?.length)context.push('To check:\n'+excerpt(alert.questions.join('\n'),700));
  if(alert.sources?.length)context.push('Original sources:\n'+excerpt(alert.sources.map(s=>[s.label,s.excerpt,s.url].filter(Boolean).join('\n')).join('\n\n'),1000));
  const url=(alert.sources||[]).map(s=>{try{const u=new URL(s.url);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}).find(Boolean);
  return {id:alert.id,title:alert.title,excerpt:context.filter(Boolean).join('\n\n').slice(0,6000),url,kind:sourceLabel(alert),receivedAt:alert.observedAt};
 }
 function adding(note,additions){
  const seen=new Set(),all=[...(note.evidence||[]),...additions].filter(e=>e&&!seen.has(e.id)&&seen.add(e.id));
  if(!all.every(e=>validID(e.id)))throw Error('This source is unavailable. Refresh and try again.');
  if(all.length>30)throw Error('A story can hold up to 30 sources. Remove a source before adding more.');
  if(all.length===(note.evidence||[]).length)return note;
  return {...note,evidence:all,relatedIDs:[...new Set([...(note.relatedIDs||[]),...all.map(e=>e.id)].filter(validID))].slice(0,20)};
 }
 async function sourceStoryID(id){
  if(!validID(id))throw Error('Invalid source.');
  return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode('source-notebook:v1:'+id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 }
 function linkedID(summaries,id){return summaries.find(n=>Array.isArray(n.sourceIDs)&&n.sourceIDs.includes(id))?.id;}
 function createClient(request){
  const inFlight=new Map(),legacyLinks=new Map();
  const load=async id=>(await request('field-get',{id})).note;
  async function attach(items,id){
   const current=await load(id);if(!current)throw Error('This story is no longer available. Refresh and try again.');
   const updated=adding(current,items);if(updated===current)return current;
   return (await request('field-save',{id,note:{...updated,revision:current.revision+1},expectedRevision:current.revision})).note;
  }
  async function findLegacy(id,summaries){
   // Only old, unindexed notes need content reads; cache IDs against their exact revision.
   const unknown=summaries.filter(n=>validID(n.id)&&!Array.isArray(n.sourceIDs));
   if(unknown.length>1000)throw Error('Choose an existing story while the older notebook index is catching up.');
   for(let offset=0;offset<unknown.length;offset+=4){
    const batch=await Promise.all(unknown.slice(offset,offset+4).map(async n=>{
     const key=n.id+':'+n.revision;let ids=legacyLinks.get(key);
     if(!ids){const note=await load(n.id);ids=(note?.evidence||[]).map(e=>e.id).filter(validID);if(legacyLinks.size>=1000)legacyLinks.delete(legacyLinks.keys().next().value);legacyLinks.set(key,ids);}
     return ids.includes(id)?n.id:null;
    }));
    const match=batch.find(Boolean);if(match)return match;
   }
  }
  async function openOnce({title,items,summaries}){
   const anchor=items[0]?.id;if(!validID(anchor))throw Error('No valid source was selected.');
   const existing=linkedID(summaries,anchor)||await findLegacy(anchor,summaries);
   if(existing)return attach(items,existing);
   const id=await sourceStoryID(anchor),current=await load(id);
   if(current){if(!(current.evidence||[]).some(e=>e.id===anchor))throw Error('This story was edited separately. Open it from your recordings and stories.');return attach(items,id);}
   const note=adding({id,revision:1,kind:'notebook',title:String(title||'Untitled story').slice(0,180),createdAt:new Date().toISOString(),transcript:'',draft:'',notes:'',duration:0,evidence:[],markers:[],relatedIDs:[],processRequested:false},items);
   try{return (await request('field-save',{id,note,expectedRevision:0})).note;}
   catch(error){
    if(error.code!==409&&error.status!==409)throw error;
    const winner=await load(id);if(!(winner?.evidence||[]).some(e=>e.id===anchor))throw error;
    return attach(items,id);
   }
  }
  function open(options){
   const key=options.items.map(e=>e.id).join(':');if(inFlight.has(key))return inFlight.get(key);
   const operation=openOnce(options).finally(()=>inFlight.delete(key));inFlight.set(key,operation);return operation;
  }
  return {open,attach};
 }
 const api={evidence,adding,sourceStoryID,linkedID,createClient};root.CerneySourceStories=api;
 if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis==='undefined'?window:globalThis);

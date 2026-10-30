'use strict';
const {sha,match,repeat}=require('./story-tracker-match');
const {evidenceContext}=require('./evidence-context');
const {sourceURL}=require('./newsroom-record');
const {summary,query,fileSummary}=require('./story-tracker-presentation');
const ID=/^[a-f0-9]{64}$/;
const fail=(message,code=400)=>Object.assign(Error(message),{code});
const clean=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
const empty=()=>({version:1,revision:0,stories:[],checkedAt:null});
function evidence(e){if(!e||!ID.test(e.id)||!Number.isFinite(Date.parse(e.receivedAt)))return null;
 const title=clean(e.title,240),excerpt=clean(e.excerpt,3000);if(!title||!excerpt)return null;
 return {id:e.id,title,excerpt,url:sourceURL(e.url),kind:clean(e.kind,40),receivedAt:e.receivedAt,context:evidenceContext(e.context)};}
function newStory(item,at){return {id:sha('story-tracker:v1:'+item.id),title:item.title,createdAt:item.receivedAt,updatedAt:item.receivedAt,status:'following',items:[{...item,connectedAt:at,reason:'First material',history:[]}],blockedIDs:[]};}
function reconcile(state,incoming,at){
 const owners=new Map(state.stories.flatMap(s=>s.items.map(e=>[e.id,s])));
 const additions=incoming.map(evidence).filter(Boolean).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id));
 for(const item of additions){
  const owner=owners.get(item.id);
  if(owner){const old=owner.items.find(x=>x.id===item.id),signature=x=>JSON.stringify([x.title,x.excerpt,x.url,x.context]);
   if(signature(old)!==signature(item)){const history=[...(old.history||[]),{title:old.title,excerpt:old.excerpt,recordedAt:old.updatedAt||old.connectedAt}].slice(-5);Object.assign(old,item,{history,updatedAt:at});owner.updatedAt=at;}continue;}
  const ranked=[];
  for(const story of state.stories){if(story.blockedIDs.includes(item.id)||!story.items.length)continue;
   // Stable anchor prevents weak transitive chains from swallowing another event.
   const anchor=story.items[0],m=match(anchor,item);if(m)ranked.push({story,...m});}
  ranked.sort((a,b)=>b.score-a.score||a.story.id.localeCompare(b.story.id));
  // Ambiguous matches remain their own story automatically; no forced merge.
  const best=ranked[0]&&(!ranked[1]||ranked[0].score>ranked[1].score)?ranked[0]:null;
  if(best){const duplicate=best.story.items.find(e=>repeat(e,item));best.story.items.push({...item,connectedAt:at,reason:best.reason,...(duplicate?{repeatedFrom:duplicate.id}:{}),history:[]});best.story.updatedAt=at;owners.set(item.id,best.story);}
  else{const story=newStory(item,at);state.stories.push(story);owners.set(item.id,story);}
 }
 state.checkedAt=at;return state;
}
function createStoryTracker({read,write,collect,clock=()=>new Date().toISOString(),name='tracker/state.json'}){
 // A single conditional object write commits links and story history together.
 // Retries always rebase onto the latest state, including separations from another phone.
 async function mutate(fn){for(let attempt=0;attempt<5;attempt++){const stored=await read(name),state=stored?.data||empty();if(await fn(state)===false)return state;state.revision++;
   if(Buffer.byteLength(JSON.stringify(state))>12*1024*1024)throw fail('Story Tracker storage needs expansion. Existing stories remain saved.',507);
   try{await write(name,state,stored?.generation||0);return state;}catch(e){if(e.code!==412||attempt===4)throw e;}}}
 let flight;
 async function sync(){if(flight)return flight;
  flight=(async()=>{const stored=await read(name);if(stored&&Date.parse(clock())-Date.parse(stored.data.checkedAt)<120000)return stored.data;
   const incoming=await collect();return mutate(state=>reconcile(state,incoming,clock()));})();
  try{return await flight;}finally{flight=null;}}
 async function handle(body){
  if(body.op==='tracker-list'){let state;try{state=await sync();}catch(e){const saved=await read(name);if(!saved)throw e;state={...saved.data,warning:e.code===507?e.message:'Automatic connections could not refresh. Showing saved stories.'};}
   if(body.cursor&&!ID.test(body.cursor))throw fail('Invalid page.');return query(state,body);}
  if(!ID.test(body.id||''))throw fail('Invalid story.');
  if(body.op==='tracker-get'){
   const s=(await read(name))?.data.stories.find(s=>s.id===body.id);if(!s)throw fail('Story not found.',404);
   const files=(await read(`producer-threads/${body.id}.json`))?.data.assets||[];
   // Also repairs metadata for uploads completed before this release.
   const state=await recordAssets(body.id,files);return {story:{...state.stories.find(s=>s.id===body.id),files}};
  }
  if(body.op==='tracker-pin'){
   if(typeof body.pinned!=='boolean')throw fail('Invalid pin state.');
   const state=await mutate(s=>{const story=s.stories.find(x=>x.id===body.id);if(!story)throw fail('Story not found.',404);if(story.pinned===body.pinned)return false;story.pinned=body.pinned;});
   return {story:state.stories.find(s=>s.id===body.id)};
  }
  if(body.op==='tracker-edit'){
   if(typeof body.title!=='string'||!body.title.trim()||body.title.length>180||typeof body.notes!=='string'||body.notes.length>15000||!Number.isInteger(body.expectedRevision)||body.expectedRevision<0)throw fail('Invalid story edits.');
   const state=await mutate(s=>{const story=s.stories.find(x=>x.id===body.id);if(!story)throw fail('Story not found.',404);
    if(story.title===body.title.trim()&&(story.notes||'')===body.notes)return false;
    if((story.editorRevision||0)!==body.expectedRevision)throw fail('This story was edited elsewhere. Your text is still here. Reopen the editor to compare.',409);
    story.title=body.title.trim();story.notes=body.notes;story.editorRevision=(story.editorRevision||0)+1;
   });return {story:state.stories.find(s=>s.id===body.id)};
  }
  if(body.op==='tracker-status'){if(!['following','archived'].includes(body.status))throw fail('Invalid status.');const state=await mutate(s=>{const story=s.stories.find(x=>x.id===body.id);if(!story)throw fail('Story not found.',404);story.status=body.status;});return {story:state.stories.find(s=>s.id===body.id)};}
  if(body.op==='tracker-separate'){if(!ID.test(body.itemID||''))throw fail('Invalid material.');const state=await mutate(s=>{
   const story=s.stories.find(x=>x.id===body.id);if(!story)throw fail('Story not found.',404);
   const index=story.items.findIndex(e=>e.id===body.itemID);if(index<0)return; // Idempotent retry after response loss.
   if(story.items.length===1)throw fail('This material already has its own story.');
   const [item]=story.items.splice(index,1);story.blockedIDs.push(item.id);story.updatedAt=clock();
   const separate=newStory(item,clock());separate.id=sha('story-tracker:separate:'+story.id+':'+item.id);separate.items=[{...item,reason:'Separated by you',repeatedFrom:undefined}];separate.blockedIDs=story.items.map(e=>e.id);s.stories.push(separate);
  });return {story:state.stories.find(s=>s.id===body.id)};}
  throw fail('Unknown Story Tracker operation.');
 }
 async function recordAssets(id,assets){
  const fields=fileSummary(assets);
  return mutate(s=>{const story=s.stories.find(x=>x.id===id);if(!story)return false;
   // Uploads only append; a slower callback must not replace a newer manifest.
   if(fields.fileCount<(story.fileCount||0))return false;
   if(JSON.stringify(fileSummaryFromStory(story))===JSON.stringify(fields))return false;
   Object.assign(story,fields);
  });
 }
 function fileSummaryFromStory(s){return {fileCount:s.fileCount||0,fileNames:s.fileNames||[],filesUpdatedAt:s.filesUpdatedAt||null};}
 return {handle,sync,recordAssets};
}
module.exports={createStoryTracker,reconcile,evidence,empty,summary};

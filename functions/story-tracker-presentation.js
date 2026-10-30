'use strict';
const timestamp=item=>item.updatedAt||item.receivedAt;
function summary(story){
 const newest=[...story.items].sort((a,b)=>timestamp(b).localeCompare(timestamp(a)))[0];
 const activityAt=[timestamp(newest||{})||story.createdAt,story.filesUpdatedAt||''].sort().at(-1);
 return {id:story.id,title:story.title,status:story.status,createdAt:story.createdAt,updatedAt:story.updatedAt,
  activityAt,itemCount:story.items.length,latest:newest?.title||'',preview:(newest?.excerpt||'').replace(/\s+/g,' ').slice(0,280),
  location:story.items[0]?.context?.location||'',kinds:[...new Set(story.items.map(e=>e.kind))],
  repeatCount:story.items.filter(e=>e.repeatedFrom).length,pinned:story.pinned===true,fileCount:story.fileCount||0,editorRevision:story.editorRevision||0};
}
function query(state,body){
 const q=typeof body.query==='string'?body.query.trim().toLowerCase():'';
 if(q.length>200||!['following','connected','pinned','archived'].includes(body.filter||'following'))throw Object.assign(Error('Invalid story search.'),{code:400});
 const filter=body.filter||'following',active=state.stories.filter(s=>s.status!=='archived');
 const counts={following:active.length,connected:active.filter(s=>s.items.length>1).length,pinned:active.filter(s=>s.pinned).length,archived:state.stories.length-active.length};
 const selected=state.stories.filter(s=>{
  if((s.status==='archived')!==(filter==='archived'))return false;
  if(filter==='connected'&&s.items.length<2||filter==='pinned'&&!s.pinned)return false;
  return !q||[s.title,s.notes||'',...(s.fileNames||[]),...s.items.flatMap(e=>[e.title,e.excerpt,e.kind,e.context?.location||''])].join('\n').toLowerCase().includes(q);
 }).map(summary).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.activityAt.localeCompare(a.activityAt)||a.id.localeCompare(b.id));
 const start=body.cursor?selected.findIndex(s=>s.id===body.cursor)+1:0,stories=selected.slice(start,start+100);
 return {stories,counts,total:selected.length,nextCursor:start+100<selected.length?stories.at(-1).id:null,checkedAt:state.checkedAt,warning:state.warning||null};
}
function fileSummary(assets){const files=assets||[];return {fileCount:files.length,fileNames:files.map(a=>a.filename),filesUpdatedAt:files.map(a=>a.savedAt||'').sort().at(-1)||null};}
module.exports={summary,query,fileSummary};

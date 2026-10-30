'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStoryTracker,reconcile,empty}=require('./story-tracker');
const {createProducerDesk,sha}=require('./producer-desk');
const at='2026-10-30T10:00:00.000Z';
const item=(n,extra={})=>({id:sha('material'+n),title:'Separate story '+n,excerpt:'Original account '+n,kind:'Tip',receivedAt:at,...extra});
function fixture(incoming=[item(0)]){
 const records=new Map(),media=new Map();let generation=0;const reads=[];
 const read=async name=>{reads.push(name);return structuredClone(records.get(name)||null);};
 const write=async(name,data,expected)=>{if(expected!==(records.get(name)?.generation||0))throw {code:412};records.set(name,{data:structuredClone(data),generation:++generation});};
 const tracker=createStoryTracker({read,write,clock:()=>at,collect:async()=>incoming});
 const producer=createProducerDesk({read,write,list:async()=>({threads:[]}),root:'test/',clock:()=>at,onMediaSaved:tracker.recordAssets,
 bucket:()=>({file:name=>({save:async bytes=>{media.set(name,bytes)},download:async()=>[media.get(name)]}),getFiles:async({prefix})=>[[...media].filter(([name])=>name.startsWith(prefix)).map(([name,bytes])=>({name,metadata:{size:bytes.length}}))]})});
 return {tracker,producer,records,media,reads};
}
test('search covers old items, notes and filenames beyond the first page; archive is separate',async()=>{
 const all=Array.from({length:121},(_,i)=>item(i)),f=fixture(all);const first=await f.tracker.handle({op:'tracker-list'});assert.equal(first.stories.length,100);
 const old=(await f.tracker.handle({op:'tracker-list',cursor:first.nextCursor})).stories[0],original=all.find(i=>sha('story-tracker:v1:'+i.id)===old.id);
 assert.equal((await f.tracker.handle({op:'tracker-list',query:original.excerpt})).stories[0].id,old.id);
 await f.tracker.handle({op:'tracker-edit',id:old.id,title:'My investigation',notes:'Follow up with the aquarium',expectedRevision:0});
 await f.tracker.recordAssets(old.id,[{filename:'dashcam-natividad.mov',savedAt:at}]);
 for(const query of ['aquarium','dashcam-natividad','My investigation'])assert.equal((await f.tracker.handle({op:'tracker-list',query})).total,1);
 await f.tracker.handle({op:'tracker-status',id:old.id,status:'archived'});
 assert.equal((await f.tracker.handle({op:'tracker-list',query:'aquarium'})).total,0);
 assert.equal((await f.tracker.handle({op:'tracker-list',query:'aquarium',filter:'archived'})).total,1);
});
test('pin keeps an older story first and changing pin does not invent new material',async()=>{
 const f=fixture([item(0),item(1,{receivedAt:'2026-10-29T09:00:00.000Z'})]);const page=await f.tracker.handle({op:'tracker-list'}),old=page.stories[1];
 await f.tracker.handle({op:'tracker-pin',id:old.id,pinned:true});const after=await f.tracker.handle({op:'tracker-list'});assert.equal(after.stories[0].id,old.id);assert.equal(after.stories[0].activityAt,old.activityAt);
 await assert.rejects(f.tracker.handle({op:'tracker-pin',id:old.id,pinned:'yes'}),{code:400});
});
test('edit conflicts preserve notes; lost-response retries succeed and automatic source corrections preserve user edits',async()=>{
 const f=fixture();const id=(await f.tracker.handle({op:'tracker-list'})).stories[0].id;
 const edit={op:'tracker-edit',id,title:'My story',notes:'Ask the witness about timing',expectedRevision:0};await f.tracker.handle(edit);await f.tracker.handle(edit);
 await assert.rejects(f.tracker.handle({...edit,notes:'Stale overwrite'}),{code:409});
 const s=f.records.get('tracker/state.json').data;reconcile(s,[item(0,{excerpt:'Source correction'})],'2026-10-30T11:00:00.000Z');const story=s.stories[0];assert.equal(story.title,edit.title);assert.equal(story.notes,edit.notes);assert.equal(story.editorRevision,1);assert.equal(story.items[0].history[0].excerpt,'Original account 0');
 await assert.rejects(f.tracker.handle({...edit,title:' ',expectedRevision:1}),{code:400});
});
test('upload metadata is append-only; loading a story repairs counts from the saved manifest',async()=>{
 const f=fixture(),id=(await f.tracker.handle({op:'tracker-list'})).stories[0].id;
 const a={filename:'a.mov',savedAt:'2026-10-30T11:00:00.000Z'},b={filename:'b.jpg',savedAt:'2026-10-30T12:00:00.000Z'};
 await f.tracker.recordAssets(id,[a,b]);await f.tracker.recordAssets(id,[a]);let page=await f.tracker.handle({op:'tracker-list'});assert.equal(page.stories[0].fileCount,2);assert.equal(page.stories[0].activityAt,b.savedAt);
 f.records.set(`producer-threads/${id}.json`,{generation:1,data:{assets:[a,b,{filename:'c.pdf',savedAt:at}]}});
 const story=(await f.tracker.handle({op:'tracker-get',id})).story;assert.equal(story.files.length,3);assert.equal(story.fileCount,3);
 const revision=f.records.get('tracker/state.json').data.revision;await f.tracker.handle({op:'tracker-get',id});assert.equal(f.records.get('tracker/state.json').data.revision,revision);
});
test('saved material can be read only through the matching story manifest and verifies every chunk',async()=>{
 const f=fixture(),id=(await f.tracker.handle({op:'tracker-list'})).stories[0].id,assetID=sha('asset'),parts=[Buffer.alloc(2*1024*1024,11),Buffer.from('last part')],hashes=parts.map(sha);
 for(const [index,bytes] of parts.entries())await f.producer({op:'producer-media-part',id,assetID,index,sha256:hashes[index],base64:bytes.toString('base64')});
 await assert.rejects(f.producer({op:'producer-media-read',id,assetID,index:0}),{code:404});
 const finish={op:'producer-media-finish',id,assetID,filename:'clip.mov',mimeType:'video/quicktime',parts:hashes,checksumMode:'parts-v1',sha256:sha(hashes.join('')),bytes:parts.reduce((n,p)=>n+p.length,0)};
 await f.producer(finish);await f.producer(finish);assert.equal((await f.tracker.handle({op:'tracker-list'})).stories[0].fileCount,1);
 for(const [index,bytes] of parts.entries()){const r=await f.producer({op:'producer-media-read',id,assetID,index});assert.deepEqual(Buffer.from(r.base64,'base64'),bytes);assert.equal(r.sha256,hashes[index]);}
 await assert.rejects(f.producer({op:'producer-media-read',id:sha('other story'),assetID,index:0}),{code:404});
 await assert.rejects(f.producer({op:'producer-media-read',id,assetID,index:2}),{code:404});
 f.media.set(`test/producer-media/${id}/${assetID}/parts/0-${hashes[0]}`,Buffer.from('corrupted'));
 await assert.rejects(f.producer({op:'producer-media-read',id,assetID,index:0}),/checksum/);
 assert.equal(f.records.get(`producer-threads/${id}.json`).data.commands.length,0);
});

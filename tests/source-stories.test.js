'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)globalThis.crypto=webcrypto;
const S=require('../tip-alerts/source-stories'),{createFieldNotes}=require('../functions/field-notes');
const source=n=>({id:n.toString(16).padStart(64,'0'),title:'Source '+n,excerpt:'Unverified original words',kind:'Facebook alert',receivedAt:'2026-10-26T10:00:00Z'});
function fixture(){
 const records=new Map(),calls=[];let generation=0,drop=false;
 const handle=createFieldNotes({read:async name=>structuredClone(records.get(name)||null),write:async(name,data,expected)=>{if((records.get(name)?.generation||0)!==expected)throw Object.assign(Error('Concurrent write'),{code:412});records.set(name,{data:structuredClone(data),generation:++generation});},bucket:()=>{throw Error('No media writes expected');},root:'test/'});
 const request=async(op,body)=>{calls.push({op,...body});try{const result=await handle({op,...body});if(drop&&op==='field-save'){drop=false;throw Error('Acknowledgment lost');}return result;}catch(e){if(e.code===412)e.code=409;throw e;}};
 return {records,calls,request,client:S.createClient(request),dropNextSave(){drop=true;},options:items=>({title:'Reporting notebook',items,summaries:[]})};
}
test('new source story is stable across retries and repeated opens preserve draft and transcript',async()=>{
 const f=fixture(),options=f.options([source(1)]),first=await f.client.open(options);
 await f.request('field-save',{id:first.id,note:{...first,revision:2,draft:'Reporter draft',transcript:'Original transcript'},expectedRevision:1});
 const reopened=await S.createClient(f.request).open(options);
 assert.equal(reopened.id,first.id);assert.equal(reopened.draft,'Reporter draft');assert.equal(reopened.transcript,'Original transcript');assert.equal(f.records.size,1);assert.equal(reopened.revision,2);
});
test('rapid duplicate taps send only one create request',async()=>{
 const f=fixture(),options=f.options([source(1)]);const [a,b]=await Promise.all([f.client.open(options),f.client.open(options)]);
 assert.equal(a.id,b.id);assert.equal(f.calls.filter(c=>c.op==='field-save').length,1);
});
test('two devices racing create one notebook without overwriting the winner',async()=>{
 const f=fixture(),options=f.options([source(1)]);const [a,b]=await Promise.all([f.client.open(options),S.createClient(f.request).open(options)]);
 assert.equal(a.id,b.id);assert.equal(f.records.size,1);
});
test('lost acknowledgment recovers the same saved notebook after a fresh client opens',async()=>{
 const f=fixture(),options=f.options([source(1)]);f.dropNextSave();await assert.rejects(f.client.open(options),/Acknowledgment/);
 const recovered=await S.createClient(f.request).open(options);assert.equal(recovered.evidence[0].id,source(1).id);assert.equal(f.records.size,1);
});
test('legacy random-ID notebook is found and its original evidence stays unchanged',async()=>{
 const f=fixture(),id='e'.repeat(64),note={id,revision:1,kind:'notebook',title:'Existing story',createdAt:'2026-10-26T10:00:00Z',transcript:'',draft:'Keep',notes:'',evidence:[source(1)]};
 await f.request('field-save',{id,note,expectedRevision:0});
 const result=await f.client.open({title:'New title',items:[{...source(1),excerpt:'Later wording'},source(2)],summaries:[{id,revision:1,title:note.title}]});
 assert.equal(result.id,id);assert.equal(result.title,'Existing story');assert.equal(result.draft,'Keep');assert.equal(result.evidence[0].excerpt,source(1).excerpt);assert.equal(result.evidence.length,2);assert.equal(f.records.size,1);
});
test('indexed unrelated notebooks do not require content downloads',async()=>{
 const f=fixture(),summaries=Array.from({length:1000},(_,n)=>({id:(n+20).toString(16).padStart(64,'0'),revision:1,sourceIDs:[source(2).id]}));
 await f.client.open({title:'New',items:[source(1)],summaries});assert.equal(f.calls.filter(c=>c.op==='field-get').length,1);
});
test('attaching a duplicate is a no-op and a full notebook rejects the entire addition',async()=>{
 const f=fixture(),note=await f.client.open(f.options(Array.from({length:30},(_,n)=>source(n+1))));const before=JSON.stringify([...f.records]);
 assert.equal((await f.client.attach([source(1)],note.id)).revision,note.revision);
 await assert.rejects(f.client.attach([source(31)],note.id),/30 sources/);assert.equal(JSON.stringify([...f.records]),before);
});
test('a concurrent edit is surfaced rather than replacing a newer draft',async()=>{
 const f=fixture(),note=await f.client.open(f.options([source(1)]));let race=true;
 const c=S.createClient(async(op,body)=>{if(op==='field-save'&&race){race=false;await f.request('field-save',{id:note.id,note:{...note,revision:2,draft:'Other device draft'},expectedRevision:1});}return f.request(op,body);});
 await assert.rejects(c.attach([source(2)],note.id),e=>e.code===409);
 assert.equal(f.records.get('field-notes/'+note.id+'.json').data.draft,'Other device draft');assert.equal(f.records.get('field-notes/'+note.id+'.json').data.evidence.length,1);
});
test('long source summaries cannot crowd out location, uncertainty, questions and contradictions',()=>{
 const a={id:source(1).id,title:'Reported activity',summary:'Long original source. '.repeat(500),location:'Seaside',timeLabel:'Event time unconfirmed',observedAt:'2026-10-26T10:00:00Z',verification:'Source report · needs verification',kind:'facebook_group',whatChanged:'Second account received',questions:['Which agency was present?'],contradictions:['Accounts disagree on location'],sources:[{label:'Original',url:'https://example.com/source',excerpt:'A source claim'}]};
 const e=S.evidence(a);for(const text of ['Seaside','not the event time','needs verification','Second account','Which agency','Accounts disagree','https://example.com/source','Excerpt shortened'])assert(e.excerpt.includes(text),text);
 assert(e.excerpt.length<=6000);assert.equal(e.url,a.sources[0].url);assert.equal(e.receivedAt,a.observedAt);
});
test('invalid source links cannot become a navigable notebook URL',()=>{
 const e=S.evidence({id:source(1).id,title:'Example',sources:[{url:'javascript:alert(1)'},{url:'https://secret@example.com'}]});assert.equal(e.url,undefined);
});

test('source notebook ID matches the native cross-platform contract',async()=>{assert.equal(await S.sourceStoryID(source(1).id),'425abaaeea487ae2ecd01ca6b1ce0a9558fa40c600cd721082d526699f1d06dd');});

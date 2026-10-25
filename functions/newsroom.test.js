'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchRecord,fieldNote,digest}=require('./newsroom-record');
const {createFieldNotes}=require('./field-notes');
const id='a'.repeat(64),base={id,revision:1,title:'Test recording',createdAt:new Date().toISOString(),transcript:'All original words.',draft:'Separate proposed draft.',notes:'',duration:5};
function fixture(){const records=new Map(),files=new Map();let gen=0;
 const read=async n=>records.get(n)||null;
 const write=async(n,data,generation)=>{if(String(records.get(n)?.generation||0)!==String(generation))throw Object.assign(Error('conflict'),{code:412});records.set(n,{data:structuredClone(data),generation:String(++gen)});};
 const bucket=()=>({file:name=>({save:async(bytes,opts)=>{if(files.has(name)&&opts.preconditionOpts.ifGenerationMatch===0)throw Object.assign(Error('exists'),{code:412});files.set(name,Buffer.from(bytes));},download:async()=>{if(!files.has(name))throw Object.assign(Error('missing'),{code:404});return [files.get(name)];}})});
 return {handler:createFieldNotes({read,write,bucket,root:'_tipalerts/v1/'}),records,files};}
test('source alerts preserve uncertainty, event time, and safe source links',()=>{
 const r=researchRecord({version:1,id,revision:1,kind:'facebook_group',title:'Reported collision',summary:'A group member reports a collision.',observedAt:new Date().toISOString(),sources:[{label:'Group post',url:'javascript:alert(1)'}],eventAt:null});
 assert.equal(r.eventAt,null);assert.equal(r.sources[0].url,null);assert.match(r.verification,/needs verification/);assert.equal(r.kind,'facebook_group');
});
test('field original transcript is distinct from draft and oversized input is rejected',()=>{assert.equal(fieldNote(base).transcript,'All original words.');assert.notEqual(fieldNote(base).draft,base.transcript);assert.throws(()=>fieldNote({...base,transcript:'x'.repeat(100001)}));});
test('note saves are idempotent but stale edits cannot overwrite newer work',async()=>{const {handler}=fixture();await handler({op:'field-save',id,note:base});await handler({op:'field-save',id,note:base});await handler({op:'field-save',id,note:{...base,revision:2,draft:'Edited'}});await assert.rejects(handler({op:'field-save',id,note:base}),e=>e.code===409);});
test('chunk retry and finalization preserve checksum verified original audio',async()=>{const {handler,records,files}=fixture();await handler({op:'field-save',id,note:base});const audio=Buffer.from('test-audio-fixture'),sha=digest(audio),part={op:'field-audio-part',id,index:0,sha256:sha,base64:audio.toString('base64')};await handler(part);await handler(part);await handler({op:'field-audio-finish',id,parts:[sha],sha256:sha});await handler({op:'field-audio-finish',id,parts:[sha],sha256:sha});assert.equal(records.get(`field-notes/${id}.json`).data.audio.sha256,sha);assert.deepEqual(files.get(`_tipalerts/v1/field-audio/${id}/original.m4a`),audio);await handler({op:'field-save',id,note:{...base,revision:2}});assert.equal(records.get(`field-notes/${id}.json`).data.audio.sha256,sha);});
test('corrupt chunks and incomplete uploads never become ready recordings',async()=>{const {handler,records}=fixture();await handler({op:'field-save',id,note:base});await assert.rejects(handler({op:'field-audio-part',id,index:0,sha256:'b'.repeat(64),base64:'YWJj'}));await assert.rejects(handler({op:'field-audio-finish',id,parts:['b'.repeat(64)],sha256:'b'.repeat(64)}));assert.equal(records.get(`field-notes/${id}.json`).data.audio,null);});
test('bad record IDs and path traversal cannot write',async()=>{const {handler}=fixture();await assert.rejects(handler({op:'field-save',id:'../../private',note:base}));});

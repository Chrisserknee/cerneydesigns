'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {draftRecord,fileRecord,fileIdentity,hasWork,open}=require('../tip-alerts/producer-drafts');
const base=()=>({version:1,id:'a'.repeat(64),text:'Keep this attributed to the witness.',title:'Example report',titleEdited:true,preferences:{format:'footage',banner:'slate',length:'standard',captions:true,originalAudio:true,noMusic:true},sourceRefs:[{kind:'research',id:'b'.repeat(64)}],assetIDs:['c'.repeat(64)],uploads:[],updatedAt:'2026-10-26T12:00:00Z'});
test('a recoverable draft retains exact context, source selection and deliberate style choices',()=>{
 const value=base();value.text='  First line\nSecond line  ';value.preferences.captions=false;
 assert.deepEqual(draftRecord(value),value);assert.equal(hasWork(value),true);
});
test('only bounded file metadata is retained, never original file bytes or blob URLs',()=>{
 const file={name:'interview.mov',size:2*1024**3,lastModified:123,type:'video/quicktime',bytes:new Uint8Array(40),url:'blob:private'};
 assert.deepEqual(Object.keys(fileRecord(file)),['name','size','lastModified','type']);assert.equal(fileIdentity(file),fileIdentity({...file}));
 assert.notEqual(fileIdentity(file),fileIdentity({...file,lastModified:124}));
});
test('malformed or oversized draft fields are rejected instead of silently trimming reporting',()=>{
 for(const change of [{text:'x'.repeat(4001)},{id:'bad'},{sourceRefs:[{kind:'admin',id:'b'.repeat(64)}]},{uploads:[{name:'bad'}]},{assetIDs:Array(21).fill('a'.repeat(64))},{updatedAt:'unknown'}])assert.throws(()=>draftRecord({...base(),...change}));
});
test('empty composer does not produce a phantom draft; waiting files and selected sources do',()=>{
 const value={...base(),text:'',title:'Existing story',titleEdited:false,sourceRefs:[],assetIDs:[]};
 assert.equal(hasWork(value),false);assert.equal(hasWork({...value,sourceRefs:base().sourceRefs}),true);assert.equal(hasWork({...value,uploads:[{name:'clip.mov'}]}),true);
});
test('only authenticated opaque device scopes can open private storage',async()=>{
 for(const scope of [undefined,'','account@example.com','../other'])await assert.rejects(open(scope,{}),/unavailable/);
});

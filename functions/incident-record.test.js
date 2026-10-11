'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {incidentRecord}=require('./incident-record');
const hash=s=>createHash('sha256').update(s).digest('hex');
const source='incident:'+'a'.repeat(20)+':e2';
const record={version:1,id:hash(source),source,jobId:hash(JSON.stringify(source)).slice(0,20),incidentId:'a'.repeat(20),edition:2,revision:1,state:'ready',draftDelivered:true,receivedAt:'2026-10-10T20:00:00Z',updatedAt:'2026-10-10T20:10:00Z',title:'Reported road closure',summary:'A report for private review.',location:'Example Road',driveUrl:'https://drive.google.com/drive/folders/example'};
test('incident card retains reviewed copy and a safe Drive folder but no raw evidence or contact',()=>{
 const result=incidentRecord({...record,privateContact:'secret@example.com',rawEvidence:'private evidence'});
 assert.equal(result.title,record.title);assert.equal(result.reportEdition,2);assert.equal(result.type,'incident');
 for(const k of ['privateContact','rawEvidence','source','jobId'])assert.equal(result[k],undefined);
});
test('wrong incident identity, arbitrary links and unfinished reports never become ready cards',()=>{
 for(const patch of [{id:'b'.repeat(64)},{jobId:'b'.repeat(20)},{incidentId:'b'.repeat(20)},{edition:1},{state:'rendering'},{draftDelivered:false},{driveUrl:'https://evil.example/test'},{receivedAt:'not a time'}])assert.equal(incidentRecord({...record,...patch}),null);
});

const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {verifyContext,contextDocuments}=require('./tip-context');
const token='a'.repeat(64),manifest={contextKeyHash:createHash('sha256').update(token).digest('hex')};
const input={contextToken:token,anonymous:true,nameUsageConsent:'anonymous',detailsStatus:'provided',whatHappened:'A test happened.',timing:'Yesterday',location:'Salinas'};
test('context capability binds a strict field allowlist and explicit consent',()=>{
 const s=verifyContext(manifest,input);assert.equal(s.description,'A test happened.\n\nWhen: Yesterday\n\nWhere: Salinas');assert.equal(s.contextToken,undefined);
 for(const bad of [{contextToken:'b'.repeat(64)},{files:[]},{submissionName:'other'},{anonymous:false},{nameUsageConsent:'use_name'},{whatHappened:'x'.repeat(2001)}]) assert.throws(()=>verifyContext(manifest,{...input,...bad}),/INVALID_CONTEXT/);
});
test('anonymous context discards identity and Drive documents never contain the capability',()=>{
 const s=verifyContext(manifest,{...input,senderName:'PRIVATE',senderContact:'secret@example.com'});
 const docs=contextDocuments({version:1,submissionName:'tips/session/_submission.json',submission:s,receivedAt:'2026-10-04T00:00:00Z'},'bucket');
 for(const file of docs){assert.doesNotMatch(file.inlineBytes.toString(),/PRIVATE|secret@example|contextToken|aaaaaaaaaa/);assert.equal(file.sizeBytes,file.inlineBytes.length);assert.equal(file.md5Hash,createHash('md5').update(file.inlineBytes).digest('base64'));assert.doesNotMatch(file.url,/token=/);}
 assert.match(docs[0].inlineBytes.toString(),/Source requests anonymity/);
});
test('permitted name and private contact remain separate from report facts',()=>{
 const s=verifyContext(manifest,{...input,anonymous:false,nameUsageConsent:'use_name',senderName:'Test Contributor',senderContact:'test@example.com'});
 assert.equal(s.senderName,'Test Contributor');assert.doesNotMatch(s.description,/Contributor|@/);
});

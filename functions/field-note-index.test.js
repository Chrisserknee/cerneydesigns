const test=require('node:test'),assert=require('node:assert/strict');
const {noteMetadata,noteSummary}=require('./field-note-index');
const id='a'.repeat(64),note={id,revision:5,title:'Private story',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T01:00:00Z',transcript:'Private original words',draft:'Private draft',notes:'Private notes',evidence:[{excerpt:'Private source'}],duration:60,audio:{sha256:'b'.repeat(64)},processRequested:true};
test('library metadata is small and excludes private transcript, draft and source excerpts',()=>{const m=noteMetadata(note);assert.equal(m.hasAudio,'true');assert.equal(m.processRequested,'true');assert(!JSON.stringify(m).includes('Private original'));assert(!JSON.stringify(m).includes('Private source'));assert(!('draft' in m));const summary=noteSummary({metadata:m},id);assert.equal(summary.id,id);assert.equal(summary.revision,5);assert.equal(summary.hasAudio,true);assert(JSON.stringify(m).length<600);});
test('mismatched IDs and incomplete legacy metadata fall back to a record read',()=>{assert.equal(noteSummary(noteMetadata(note),'b'.repeat(64)),null);assert.equal(noteSummary({},id),null);assert.equal(noteSummary({...noteMetadata(note),revision:'no'},id),null);});
test('completed processing and audio metadata update with each committed revision',()=>{const m=noteMetadata({...note,revision:6,audio:null,processRequested:false});assert.equal(m.revision,'6');assert.equal(m.hasAudio,'false');assert.equal(m.processRequested,'false');});
test('source linkage is bounded, deduplicated and does not expose evidence text',()=>{
 const ids=Array.from({length:40},(_,n)=>n.toString(16).padStart(64,'0'));
 const m=noteMetadata({...note,kind:'notebook',evidence:ids.flatMap(id=>[{id,excerpt:'Private source'},{id}])});
 assert.equal(noteSummary(m,id).sourceIDs.length,30);assert.equal(noteSummary(m,id).kind,'notebook');assert(!JSON.stringify(m).includes('Private source'));assert(JSON.stringify(m).length<4096);
});
test('legacy or malformed source indexes remain unknown and do not claim no sources',()=>{
 const m=noteMetadata(note);delete m.sourceIDs;assert.equal(noteSummary(m,id).sourceIDs,undefined);
 for(const value of ['bad','{}','["invalid"]'])assert.equal(noteSummary({...m,sourceIDs:value},id).sourceIDs,undefined);
 assert.deepEqual(noteSummary({...m,sourceIDs:'[]'},id).sourceIDs,[]);
});

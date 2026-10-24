'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {voiceTip,refreshFromStored,voiceMonitor}=require('./voice-tip');
const {displayContext}=require('./tip-inbox-context');
const {storyMonitor}=require('./story-request-record');
const id='a'.repeat(64),record={id,sourceKind:'google_voice',path:`_tipalerts/v1/voice-sources/${id}.json`,receivedAt:new Date().toISOString(),status:'ready',sourceDescription:'A community tip.',sourceSummary:'A community tip.'};
test('Voice details and forced refresh use stored text without a media manifest',()=>{
 assert(voiceTip(record));assert(refreshFromStored(record,true));assert.equal(displayContext(record).submission.text,'A community tip.');
 assert(!voiceTip({...record,path:'tips/unrelated.json'}));assert(!refreshFromStored({...record,sourceKind:'upload'},true));
});
test('Voice and Story health cannot remain healthy after their workers stop',()=>{
 assert.equal(voiceMonitor({version:1,status:'healthy',lastSuccessfulCheckAt:'2000-01-01T00:00:00Z'}).status,'attention');
 assert.equal(voiceMonitor({version:1,status:'healthy',lastSuccessfulCheckAt:new Date().toISOString()}).status,'healthy');
 assert.equal(storyMonitor({version:1,status:'healthy',checkedAt:'2000-01-01T00:00:00Z'}).status,'attention');
});

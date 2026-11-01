'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {timing}=require('../tip-alerts/story-clock');
const {storyRequest,withReportReceipt}=require('../functions/story-request-record');
const now=Date.parse('2026-11-01T20:00:00Z');
const draft={version:1,id:'a'.repeat(64),state:'draft',revision:1,headline:'Reported crash near Natividad, Salinas. Did you see it?',question:'Send photos or video to me.',location:'Salinas',basis:'reported',createdAt:'2026-11-01T19:45:00Z',updatedAt:'2026-11-01T19:45:00Z',expiresAt:'2026-11-02T18:00:00Z',sources:[{label:'Community tip',tipId:'b'.repeat(64)}]};
test('Pacific clock distinguishes both instances of 1:30 during daylight saving change',()=>{
 assert.deepEqual(timing({...draft,reportReceivedAt:'2026-11-01T08:30:00Z'}),{label:'REPORT RECEIVED',digits:'01:30',period:'AM',dateLine:'NOV 01, 2026',zone:'PDT'});
 assert.equal(timing({...draft,reportReceivedAt:'2026-11-01T09:30:00Z'}).zone,'PST');
 assert.equal(timing({...draft,reportReceivedAt:'2026-11-01T07:02:00Z'}).digits,'12:02');
});
test('legacy draft time and examples have honest labels; private timing notes are not public clock values',()=>{
 assert.equal(timing(draft).label,'DRAFT PREPARED');assert.equal(timing(draft).digits,'11:45');
 assert.equal(timing({...draft,basis:'demo'}).label,'EXAMPLE TIME');
 assert.equal(timing({...draft,createdAt:'bad',timeLabel:'5 PM private source call'}).digits,'--:--');
 assert.deepEqual(timing({...draft,timeLabel:'8 AM',eventAt:'2026-11-01T08:00:00Z'}),timing(draft));
});
test('arrival is recovered from already-imported linked tips; generation and AI event time are never substituted',()=>{
 const tips=new Map([['b'.repeat(64),{receivedAt:'2026-11-01T18:42:00Z'}]]);
 const record=storyRequest(withReportReceipt({...draft,eventAt:'2026-11-01T17:00:00Z'},tips,now),now);
 assert.equal(record.reportReceivedAt,'2026-11-01T18:42:00.000Z');
 assert.equal(storyRequest(draft,now).reportReceivedAt,null);
 assert.equal(storyRequest({...draft,reportReceivedAt:'2099-01-01T00:00:00Z'},now).reportReceivedAt,null);
 assert.equal(storyRequest({...draft,reportReceivedAt:'2026-11-01T08:00:00'},now).reportReceivedAt,null);
});
test('follow-up receipts retain the first report date even after a draft is revised',()=>{
 const sources=[{...draft.sources[0],receivedAt:'2026-11-01T19:00:00Z'},{label:'Earlier report',receivedAt:'2026-10-31T23:55:00-07:00'}];
 const result=storyRequest({...draft,sources,reportReceivedAt:'2026-11-01T19:20:00Z'},now);
 assert.equal(result.reportReceivedAt,'2026-11-01T06:55:00.000Z');assert.equal(timing(result).dateLine,'OCT 31, 2026');
 assert.doesNotMatch(JSON.stringify(result.sources),/receivedAt/);
});
test('clock script loads before rendering and has no third-party requests',()=>{
 const fs=require('node:fs'),html=fs.readFileSync(__dirname+'/../tip-alerts/index.html','utf8');
 assert(html.indexOf('story-clock.js')<html.indexOf('story-requests.js'));assert.doesNotMatch(fs.readFileSync(__dirname+'/../tip-alerts/story-clock.js','utf8'),/fetch\(|https:\/\//);
});

'use strict';
const {fingerprint}=require('./story-tracker-match');
const {researchRecord}=require('./newsroom-record');
const {scannerFeed}=require('./scanner-feed');
// Only existing private imports are read. This module cannot call Gmail, send
// mail, scrape Facebook, fetch linked URLs or invoke a model.
function sources({tips=[],research=[],incidents=[],scanner},now=Date.now()){
 const recent=at=>Number.isFinite(Date.parse(at))&&Date.parse(at)>now-30*86400000&&Date.parse(at)<=now+300000;
 const result=tips.filter(t=>recent(t.receivedAt)).map(t=>({id:t.id,title:t.sourceTitle||t.title||'Submitted material',excerpt:t.sourceDescription||t.sourceSummary||t.summary||'Media submitted without a written description.',url:t.sourceUrl||t.driveUrl,kind:t.sourceKind==='google_voice'?'Google Voice':'Tip',receivedAt:t.receivedAt,context:{location:t.sourceLocation||t.location,textFingerprint:fingerprint(t.sourceDescription||t.sourceSummary)}}));
 for(const raw of research){const r=researchRecord(raw);if(!r||!recent(r.observedAt))continue;
  result.push({id:r.id,title:r.title,excerpt:r.summary,url:r.sources.find(s=>s.url)?.url,kind:r.kind==='facebook_group'?'Facebook alert':r.kind==='official_statement'?'Official statement':'Research',receivedAt:r.observedAt,context:{location:r.location,eventAt:r.eventAt,textFingerprint:fingerprint(r.sources.map(s=>s.excerpt).join('\n')),questions:r.questions,contradictions:r.contradictions}});}
 for(const r of incidents){if(!recent(r.receivedAt||r.observedAt))continue;result.push({id:r.id,title:r.title,excerpt:r.summary||r.sourceText,url:r.sourceUrl,kind:'Official report',receivedAt:r.receivedAt||r.observedAt,context:{location:r.location,textFingerprint:fingerprint(r.sourceText)}});}
 for(const e of scannerFeed(scanner,now).events){
  // Routine radio chatter is still in Scanner, but does not flood Story Tracker.
  if(e.kind==='radio'&&!/\b(crash|collision|shooting|gunfire|fire|protest|missing|robbery|burglary|immigration)\b/i.test(e.title+' '+e.summary))continue;
  result.push({id:e.id,title:e.title,excerpt:e.summary||e.title,url:e.sourceURL,kind:e.kind==='radio'?'Scanner · unverified':e.kind==='weather'?'Weather':'Agency update',receivedAt:e.observedAt,context:{location:e.location,textFingerprint:fingerprint(e.summary)}});}
 return result;
}
module.exports={sources};

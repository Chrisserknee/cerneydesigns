'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {match,sha,fingerprint,sourceKey}=require('./story-tracker-match');
const {createStoryTracker,reconcile,empty}=require('./story-tracker');
const {sources}=require('./story-tracker-sources');
const at='2026-10-30T10:00:00.000Z';
const item=(name,over={})=>({id:sha(name),title:'Injury crash at Natividad and Laurel in Salinas',excerpt:'A witness reports an injury collision near the intersection.',kind:'Tip',receivedAt:at,context:{location:'Natividad Road and Laurel Drive, Salinas'},...over});
function memory(){let state,generation=0,conflict=false;return {read:async()=>state?{data:structuredClone(state),generation}:null,write:async(name,data,expected)=>{if(conflict){conflict=false;state=state||empty();generation++;throw {code:412};}if(expected!==generation)throw {code:412};state=structuredClone(data);generation++;},conflict:()=>{conflict=true;},get:()=>state};}
test('specific same place and event connects automatically and remains idempotent',()=>{const s=reconcile(empty(),[item('a'),item('b')],at);assert.equal(s.stories.length,1);assert.equal(s.stories[0].items.length,2);reconcile(s,[item('a'),item('b')],at);assert.equal(s.stories[0].items.length,2);});
test('different cities, intersections, explicit event times and vague city-only claims do not merge',()=>{
 for(const context of [{location:'La Jolla'},{location:'Main Street and Market Street, Salinas'},{location:'Salinas'},{location:'Natividad Road and Laurel Drive, Salinas',eventAt:'2026-10-28T10:00:00Z'}]){
 const a=item('a',{context:{location:'Natividad Road and Laurel Drive, Salinas',eventAt:at}}),b=item('b',{title:'Injury crash',context});assert.equal(match(a,b),null);}
 assert.equal(match(item('a'),item('b',{title:'Reported fire at Natividad and Laurel',excerpt:'Building burning.'})),null);
});
test('future follow-ups use enduring incident references and specific source links, not old keyword overlap',()=>{
 const later='2026-12-01T10:00:00Z';assert.equal(match(item('a'),item('b',{receivedAt:later})),null);
 const a=item('a',{title:'Salinas case #2026-9981 collision'}),b=item('b',{title:'Salinas case #2026-9981 follow-up',receivedAt:later});assert.equal(match(a,b).score,95);
 const url='https://www.facebook.com/groups/example/posts/123456789';assert.equal(match(item('a',{url}),item('b',{url,receivedAt:later})).repeated,true);
 for(const url of ['https://mail.google.com/mail/u/0/#inbox/thread','https://facebook.com/salinas','https://example.org/news','https://maps.apple.com/?q=salinas'])assert.equal(sourceKey(url),null);
});
test('copied wording is connected but marked as repetition and no independent source count exists',()=>{
 const text='This is a witness account with enough original wording to identify an exact repost of the same account in a second imported message.';
 const a=item('a',{context:{textFingerprint:fingerprint(text)}}),b=item('b',{context:{textFingerprint:fingerprint(text)}});const s=reconcile(empty(),[a,b],at);
 assert.equal(s.stories[0].items[1].repeatedFrom,s.stories[0].items[0].id);assert.equal(s.stories[0].independentSources,undefined);
});
test('new matching evidence cannot form a weak chain across two incidents',()=>{const a=item('a'),b=item('b'),c=item('c',{title:'Crash near Laurel and Main Salinas',context:{location:'Laurel and Main, Salinas'}});const s=reconcile(empty(),[a,b,c],at);assert.equal(s.stories.length,2);});
test('original source updates retain earlier wording, story identity and archive status',()=>{const a=item('a'),s=reconcile(empty(),[a],at),id=s.stories[0].id;s.stories[0].status='archived';reconcile(s,[{...a,excerpt:'Corrected witness account.'}],at);assert.equal(s.stories[0].id,id);assert.equal(s.stories[0].status,'archived');assert.equal(s.stories[0].items[0].history[0].excerpt,a.excerpt);});
test('conditional writes retry without duplicate stories; separation survives synchronization and retries',async()=>{
 const mem=memory();let now=at;const tracker=createStoryTracker({...mem,collect:async()=>[item('a'),item('b')],clock:()=>now});mem.conflict();const page=await tracker.handle({op:'tracker-list'});assert.equal(page.stories.length,1);
 const id=page.stories[0].id;await tracker.handle({op:'tracker-separate',id,itemID:item('b').id});await tracker.handle({op:'tracker-separate',id,itemID:item('b').id});now='2026-10-30T11:00:00Z';await tracker.sync();assert.equal(mem.get().stories.length,2);assert.deepEqual(mem.get().stories.map(s=>s.items.length),[1,1]);
});
test('overlapping refreshes coalesce and cooldown avoids recollecting unchanged imports',async()=>{const mem=memory();let calls=0;const tracker=createStoryTracker({...mem,clock:()=>at,collect:async()=>{calls++;return [item('a')];}});await Promise.all([tracker.sync(),tracker.sync(),tracker.sync()]);await tracker.sync();assert.equal(calls,1);});
test('failed collection returns saved stories and a visible warning',async()=>{const mem=memory();await mem.write('',reconcile(empty(),[item('a')],'2026-10-29T10:00:00Z'),0);const tracker=createStoryTracker({...mem,clock:()=>at,collect:async()=>{throw Error('offline');}});const page=await tracker.handle({op:'tracker-list'});assert.equal(page.stories.length,1);assert.match(page.warning,/could not refresh/);});
test('pagination and archive never delete source history',async()=>{const mem=memory();const all=Array.from({length:105},(_,i)=>item(String(i),{context:{},title:'Separate submitted material '+i}));const tracker=createStoryTracker({...mem,clock:()=>at,collect:async()=>all});const first=await tracker.handle({op:'tracker-list'}),second=await tracker.handle({op:'tracker-list',cursor:first.nextCursor});assert.equal(first.stories.length,100);assert.equal(second.stories.length,5);const id=first.stories[0].id;await tracker.handle({op:'tracker-status',id,status:'archived'});assert.equal((await tracker.handle({op:'tracker-get',id})).story.items.length,1);});
test('import adapters use existing data, preserve uncertainty, exclude radio chatter, and never invent event dates',()=>{
 const data=sources({tips:[{id:sha('tip'),sourceTitle:'Witness report',sourceDescription:'Reported incident',sourceKind:'google_voice',receivedAt:at}],scanner:{version:1,updatedAt:at,sources:[],events:[{id:sha('chatter'),kind:'radio',title:'26 out with 28',observedAt:at},{id:sha('radio'),kind:'radio',title:'Reported injury crash',summary:'Unverified radio traffic',observedAt:at}]}},Date.parse(at));assert.equal(data.length,2);assert.equal(data[0].kind,'Google Voice');assert.equal(data[1].context.eventAt,undefined);assert.match(data[1].kind,/unverified/);
});

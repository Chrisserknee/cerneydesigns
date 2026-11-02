'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWarmCache}=require('./inbox-warm-cache'),{InboxRecordCache}=require('./inbox-record-cache');
const name='_tipalerts/v1/tips/'+'a'.repeat(64)+'.json',entry=[name,{generation:'12',data:{id:'a'.repeat(64),title:'Saved'}}];
test('cold requests share one bootstrap read and unchanged caches do not rewrite storage',async()=>{
 const cache=new InboxRecordCache();let reads=0,writes=0;
 const warm=createWarmCache({cache,read:async()=>{reads++;return {version:1,entries:[entry]};},write:async()=>writes++});
 await Promise.all([warm.hydrate(),warm.hydrate()]);assert.equal(reads,1);assert.equal(cache.get(name).generation,'12');
 await warm.save();assert.equal(writes,0);
 cache.set(name,{generation:'13',data:{title:'Changed'}},20);await warm.save();await warm.save();assert.equal(writes,1);
});
test('unavailable or invalid warm caches do not prevent rebuilding from live records',async()=>{
 for(const read of [async()=>{throw Error('Unavailable');},async()=>({version:1,entries:[['private/devices/token',{generation:'12',data:{secret:'bad'}}],['../bad',{generation:'12',data:{}}]]})]){
  const cache=new InboxRecordCache();let saved;
  const warm=createWarmCache({cache,read,write:async value=>{saved=value;}});await warm.hydrate();assert.equal(cache.bytes,0);
  cache.set(name,entry[1],20);await warm.save();assert.equal(saved.entries.length,1);
 }
});
test('failed bootstrap writes back off without failing the inbox',async()=>{
 const cache=new InboxRecordCache();let time=0,attempts=0;
 const warm=createWarmCache({cache,now:()=>time,read:async()=>null,write:async()=>{attempts++;throw Error('Unavailable');}});
 await warm.hydrate();cache.set(name,entry[1],20);await warm.save();await warm.save();assert.equal(attempts,1);
 time=60001;await warm.save();assert.equal(attempts,2);
});

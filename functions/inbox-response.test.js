'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inboxResponse}=require('./inbox-response');
const {InboxRecordCache}=require('./inbox-record-cache');
const content={tips:[{id:'a',title:'Original',media:{version:'one'}}],reports:[],storyRequests:[]};
test('unchanged card data sends only fresh health, without duplicating the inbox',()=>{
 const full=inboxResponse(content,{authenticated:true,monitor:{status:'first'}});
 const same=inboxResponse(content,{authenticated:true,monitor:{status:'fresh'}},full.contentRevision);
 assert.equal(same.unchanged,true);assert.equal(same.tips,undefined);assert.equal(same.reports,undefined);assert.equal(same.storyRequests,undefined);
 assert.equal(same.monitor.status,'fresh');assert.equal(same.contentRevision,full.contentRevision);
});
test('additions, removals, edits, media changes and outreach expiry all return a full current inbox',()=>{
 const revision=inboxResponse(content,{}).contentRevision;
 for(const changed of [{...content,tips:[]},{...content,tips:[...content.tips,{id:'new'}]},
  {...content,tips:[{...content.tips[0],title:'Correction'}]},
  {...content,tips:[{...content.tips[0],media:{version:'two'}}]},
  {...content,reports:[{id:'report'}]},{...content,storyRequests:[{id:'outreach'}]}]){
  const next=inboxResponse(changed,{},revision);assert.equal(next.unchanged,undefined);assert.deepEqual(next.tips,changed.tips);assert.notEqual(next.contentRevision,revision);
 }
});
test('legacy clients and unknown revisions always receive the full list',()=>{
 for(const revision of [undefined,'invalid','0'.repeat(64)])assert.deepEqual(inboxResponse(content,{},revision).tips,content.tips);
});
test('record cache is bounded by both bytes and entries and retains recently used records',()=>{
 const cache=new InboxRecordCache({byteLimit:10,entryLimit:2});
 cache.set('a',{data:1},4);cache.set('b',{data:2},4);cache.get('a');cache.set('c',{data:3},4);
 assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a').data,1);assert.equal(cache.bytes,8);
 cache.set('d',{data:4},9);assert.equal(cache.get('a'),undefined);assert.equal(cache.get('c'),undefined);assert.equal(cache.bytes,9);
 cache.set('d',{data:5},20);assert.equal(cache.get('d'),undefined);assert.equal(cache.bytes,0);
});
test('a library larger than the old 1000-entry cap stays cached within its byte budget',()=>{
 const cache=new InboxRecordCache();for(let i=0;i<1800;i++)cache.set(String(i),{generation:'1',data:i},100);
 for(let i=0;i<1800;i++)assert.equal(cache.get(String(i)).data,i);assert.equal(cache.bytes,180000);
 cache.delete('17');assert.equal(cache.get('17'),undefined);assert.equal(cache.bytes,179900);
});

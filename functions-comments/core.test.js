'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {createCommentsService} = require('./core');
const storyId = '11111111-1111-4111-8111-111111111111';
const a = {token:'a'.repeat(64), clientKey:'network-a'}, b = {token:'b'.repeat(64), clientKey:'network-b'};
function fixture() {
  const records = new Map(); let generation = 0, conflict = false;
  const post = {id:storyId,title:'Test video',status:'published',publishAt:'2026-01-01T00:00:00Z',media:[{type:'video/mp4'}]};
  const store = {
    async read(k) { return structuredClone(records.get(k) || null); },
    async write(k, data, old) {
      if (conflict) { conflict = false; throw Object.assign(new Error('conflict'),{code:412}); }
      if ((records.get(k)?.generation || 0) !== old) throw Object.assign(new Error('conflict'),{code:412});
      records.set(k, {data:structuredClone(data),generation:++generation});
    },
    async catalog() { return {posts:[post]}; },
    async listThreads() { return [...records.entries()].filter(([k])=>k.startsWith('threads/')).map(([,r])=>structuredClone(r.data)); }
  };
  return {handle:createCommentsService({store,secret:()=> 'test-only-secret'.repeat(3),now:()=>Date.parse('2026-11-14T00:00:00Z')}).handle,post,records,setConflict:()=>{conflict=true;}};
}
const create = (f, context=a, override={}) => f.handle({op:'create',storyId,commentId:randomUUID(),displayName:'Coast viewer',text:'Thanks for the update.',consent:true,...override},context);
const list = (f, context={}) => f.handle({op:'list',storyId},context);
const moderate = (f,id,action='approve') => f.handle({op:'admin-moderate',storyId,commentId:id,action},{admin:true});
test('pending comments are private to their creator until review; no credential or network data is public',async()=>{
  const f=fixture(), {comment}=await create(f);
  assert.equal((await list(f)).comments.length,0);
  assert.equal((await list(f,b)).count,0);
  assert.equal((await list(f,a)).comments[0].status,'pending');
  await moderate(f,comment.id);
  const visible=await list(f,b);
  assert.equal(visible.count,1); assert.equal(visible.comments[0].mine,false);
  assert.deepEqual(Object.keys(visible.comments[0]).sort(),['authorId','createdAt','displayName','id','mine','status','text']);
  assert(!JSON.stringify(visible).includes(a.token));
});
test('forged admin JSON cannot read queue, approve or ban',async()=>{
  const f=fixture();
  await assert.rejects(f.handle({op:'admin-list',admin:true}),{status:401});
  await assert.rejects(f.handle({op:'admin-moderate',admin:true,storyId,commentId:randomUUID(),action:'approve'},a),{status:401});
});
test('draft, scheduled and non-video stories never accept or expose comments',async()=>{
  for(const change of [{status:'draft'},{publishAt:'2027-01-01T00:00:00Z'},{media:[{type:'image/jpeg'}]}]) {
    const f=fixture();Object.assign(f.post,change);
    await assert.rejects(create(f),{status:404}); await assert.rejects(list(f),{status:404});
  }
});
test('owner can delete; other viewers cannot; deletion removes the text and survives moderation retries',async()=>{
  const f=fixture(),{comment}=await create(f); await moderate(f,comment.id);
  await assert.rejects(f.handle({op:'delete',storyId,commentId:comment.id},b),{status:403});
  await f.handle({op:'delete',storyId,commentId:comment.id},a);
  await assert.rejects(moderate(f,comment.id),{status:404});
  assert.equal((await list(f,a)).comments.length,0);
  assert.equal(f.records.get('threads/'+storyId+'.json').data.comments[0].text,'');
});
test('posting is idempotent across retry and storage generation conflict',async()=>{
  const f=fixture(),id=randomUUID(); f.setConflict();
  await create(f,a,{commentId:id});await create(f,a,{commentId:id});
  assert.equal((await list(f,a)).comments.length,1);
  await assert.rejects(create(f,b,{commentId:id}),{status:409});
});
test('report hides content pending review; viewer blocks and admin bans apply across threads',async()=>{
  const f=fixture(),{comment}=await create(f);await moderate(f,comment.id);
  await f.handle({op:'block',storyId,authorId:comment.authorId},b);
  assert.equal((await list(f,b)).comments.length,0);assert.equal((await list(f)).count,1);
  await f.handle({op:'report',storyId,commentId:comment.id,reason:'Harassment'},b);
  assert.equal((await list(f)).count,0);
  const queue=await f.handle({op:'admin-list'},{admin:true});assert.equal(queue.comments[0].status,'flagged');
  await moderate(f,comment.id,'ban'); await assert.rejects(create(f),{status:403});
});
test('all comments from this device can be erased and private pending text stays hidden',async()=>{
  const f=fixture();await create(f);await create(f,b);
  await f.handle({op:'delete-all'},a);
  assert.equal((await list(f,a)).comments.length,0);assert.equal((await list(f,b)).comments.length,1);
});
test('consent, input size, reserved names, pagination and persisted rate limits are enforced',async()=>{
  const f=fixture();
  for(const change of [{consent:false},{displayName:'CN Moderator'},{text:'a'.repeat(1001)},{text:''}]) await assert.rejects(create(f,a,change),{status:400});
  await assert.rejects(f.handle({op:'list',storyId,offset:-1}),{status:400});
  for(let i=0;i<6;i++) await create(f);
  await assert.rejects(create(f),{status:429});
});

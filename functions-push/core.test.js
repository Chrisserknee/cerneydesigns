'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createPushService}=require('./core');
const storyId='11111111-1111-4111-8111-111111111111';
const a={token:'a'.repeat(64),clientKey:'a-network'},b={token:'b'.repeat(64),clientKey:'b-network'};
function fixture(){
 let now=Date.parse('2026-11-14T10:00:00Z'),generation=0,provider='ok';const records=new Map(),messages=[];
 const post={id:storyId,title:'Test public video',status:'published',publishAt:new Date(now-100000).toISOString(),notify:true,media:[{type:'video/mp4'}]};
 const store={async read(k){return structuredClone(records.get(k)||null);},async write(k,data,old){if((records.get(k)?.generation||0)!==old)throw Object.assign(new Error('conflict'),{code:412});records.set(k,{data:structuredClone(data),generation:++generation});},async remove(k){records.delete(k);},async list(prefix){return [...records.entries()].filter(([k])=>k.startsWith(prefix)).map(([,r])=>structuredClone(r.data));},async catalog(){return {posts:[post]};}};
 const service=createPushService({store,secret:()=> 'test-only-secret'.repeat(3),now:()=>now,send:async m=>{messages.push(m);if(provider==='throw')throw new Error('provider outage');if(provider==='invalid')return {status:'error',details:{error:'DeviceNotRegistered'}};return {status:'ok',id:'ticket-'+messages.length};},receipts:async ids=>Object.fromEntries(ids.map(id=>[id,provider==='invalid'?{status:'error',details:{error:'DeviceNotRegistered'}}:{status:'ok'}]))});
 return {...service,post,store,records,messages,advance:ms=>{now+=ms;},publish:()=>{now+=1000;post.id=randomUUID();post.publishAt=new Date(now).toISOString();},provider:p=>{provider=p;}};
}
const register=(f,context=a,changes={})=>f.handle({op:'register',consent:true,platform:'ios',reports:true,breaking:true,pushToken:'ExpoPushToken[test-token-12345678]',...changes},context);
test('registration needs explicit consent and valid token; status never leaks tokens or identity',async()=>{
 const f=fixture();await assert.rejects(register(f,a,{consent:false}),{status:400});await assert.rejects(register(f,a,{pushToken:'invalid'}),{status:400});
 await register(f);const status=await f.handle({op:'status'},a);assert.equal(status.enabled,true);assert(!JSON.stringify(status).includes('ExpoPushToken'));assert(!JSON.stringify(status).includes(a.token));
});
test('no historical report replay; new published selected reports queue once and receipts clean up',async()=>{
 const f=fixture();await register(f);await f.drain();assert.equal(f.messages.length,0);
 f.publish();await f.drain();assert.equal(f.messages.length,1);assert.equal(f.messages[0].data.storyId,f.post.id);assert.equal(f.messages[0].title,'Cerney News · New report');
 await f.drain();assert.equal(f.messages.length,1);
 f.advance(20000);await f.checkReceipts();assert.equal((await f.store.list('receipts/')).length,0);assert.equal((await f.store.list('deliveries/'))[0].state,'accepted');
});
test('disabled devices, deselected reports, drafts and publisher notify=false do not receive reports',async()=>{
 for(const change of ['disable','pref','draft','notify']){const f=fixture();await register(f,a,change==='pref'?{reports:false}:{});f.publish();if(change==='disable')await f.handle({op:'disable'},a);if(change==='draft')f.post.status='draft';if(change==='notify')f.post.notify=false;await f.drain();assert.equal(f.messages.length,0,change);}
});
test('breaking is explicit, authenticated, linked to public story and respects choice',async()=>{
 const f=fixture();await register(f,a,{breaking:false});
 const body={op:'admin-send',storyId,requestId:randomUUID(),confirm:true,admin:true};await assert.rejects(f.handle(body,a),{status:401});
 await f.handle(body,{admin:true});await f.drain();assert.equal(f.messages.length,0);
 f.post.status='draft';await assert.rejects(f.handle({...body,requestId:randomUUID()},{admin:true}),{status:404});
});
test('a copied Expo token is sent to only its current device registration',async()=>{
 const f=fixture();await register(f,a);await register(f,b);f.publish();await f.drain();assert.equal(f.messages.length,1);
});
test('uncertain provider responses are not resent as duplicate alerts; invalid devices are disabled',async()=>{
 for(const mode of ['throw','invalid']){const f=fixture();await register(f);f.publish();f.provider(mode);await f.drain();await f.drain();assert.equal(f.messages.length,1);if(mode==='invalid')assert.equal((await f.handle({op:'status'},a)).enabled,false);else assert.equal((await f.store.list('deliveries/'))[0].state,'unconfirmed');}
});
test('test targets only requesting device, and accepted provider receipt is distinct from phone delivery',async()=>{
 const f=fixture();await register(f);await f.handle({op:'test'},a);assert.equal(f.messages.length,1);assert.equal(f.messages[0].data.screen,'notifications');
 assert.equal((await f.handle({op:'status'},a)).lastTest.state,'queued');f.advance(20000);await f.checkReceipts();assert.equal((await f.handle({op:'status'},a)).lastTest.state,'accepted');
 await f.handle({op:'test'},a);await assert.rejects(f.handle({op:'test'},a),{status:429});
});
test('a failed receipt for an old rotated token does not disable a fresh token',async()=>{
 const f=fixture();await register(f);await f.handle({op:'test'},a);await register(f,a,{pushToken:'ExpoPushToken[new-token-12345678]'});f.advance(20000);f.provider('invalid');await f.checkReceipts();assert.equal((await f.handle({op:'status'},a)).enabled,true);
});

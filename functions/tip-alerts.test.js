'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const h=require('./tip-alerts-helpers');
const subscription={endpoint:'https://web.push.apple.com/test',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}};
const now=Date.now();const tip={id:'a'.repeat(64),receivedAt:new Date(now-1000).toISOString(),type:'upload',status:'processing'};
const device={id:'b'.repeat(64),subscription,subscribedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+86400000).toISOString()};
const keys={enabledAt:new Date(now-60000).toISOString(),publicKey:'public',privateKey:'private'};
function harness({send=async()=>{},fetchImpl=async()=>({ok:false}), initial={}}={}){
 const files=new Map(Object.entries(initial).map(([name,data])=>[name,{data,generation:1}]));let generation=1;const counts={metadata:0,downloads:0};
 const b={file(name,opts={}){return {name,getMetadata:async()=>{counts.metadata++;const x=files.get(name);if(!x)throw Object.assign(Error(),{code:404});return [{generation:x.generation,...(x.metadata||{})}];},download:async()=>{counts.downloads++;const x=files.get(name);if(!x || (opts.generation && opts.generation!==x.generation))throw Object.assign(Error(),{code:404});return [Buffer.from(JSON.stringify(x.data))];},save:async(value,opts)=>{const old=files.get(name);const expected=opts.preconditionOpts?.ifGenerationMatch;if(expected!==undefined && expected!==(old?.generation || 0))throw Object.assign(Error(),{code:412});files.set(name,{data:JSON.parse(value),generation:++generation});}};},getFiles:async({prefix})=>[[...files.keys()].filter(n=>n.startsWith(prefix)).map(name=>({name,metadata:{generation:files.get(name).generation}}))]};
 const c=vm.createContext({exports:{},Buffer,URL,Date,Intl,AbortSignal,fetch:fetchImpl,require(name){
 if(name==='firebase-functions/params')return {defineSecret:()=>({value:()=> 'test-secret'.repeat(4)})};
 if(name==='web-push')return {sendNotification:send,generateVAPIDKeys:()=>keys};
 if(name==='firebase-admin/storage')return {getStorage:()=>({bucket:()=>b})};
 if(name==='firebase-functions')return {logger:{info(){},warn(){},error(){}}};
 if(name==='firebase-functions/v2/storage')return {onObjectFinalized:(_,f)=>f,onObjectMetadataUpdated:(_,f)=>f};
 if(name==='firebase-functions/v2/scheduler')return {onSchedule:(_,f)=>f};
 if(name==='firebase-functions/v2/https')return {onRequest:(_,f)=>f};
 return require(name);
 }});
 vm.runInContext(fs.readFileSync(__dirname+'/tip-alerts.js','utf8')+'\nthis.testing={deliver,authenticate,handleApi,syncTip,adminVerified,updateDevice,reserveLogin,secureHandleApi,inboxDocuments};',c);
 return {...c.testing,files,counts};
}
test('only supported HTTPS push endpoints and correctly sized keys are accepted',()=>{
 assert.equal(h.validSubscription(subscription),true);
 for(const endpoint of ['http://web.push.apple.com/test','https://web.push.apple.com.evil.test/x','https://localhost/x','https://169.254.169.254/latest','https://web.push.apple.com:444/x','https://user:pass@web.push.apple.com/x'])assert.equal(h.validSubscription({...subscription,endpoint}),false);
 assert.equal(h.validSubscription({...subscription,keys:{...subscription.keys,auth:'tiny'}}),false);
});
test('Drive links cannot become arbitrary redirects',()=>{
 assert.equal(h.driveUrl('https://drive.google.com/drive/folders/abc_123?usp=sharing'),'https://drive.google.com/drive/folders/abc_123');
 for(const url of ['javascript:alert(1)','https://drive.google.com.evil/x','https://drive.google.com/redirect?to=evil','https://user@drive.google.com/drive/folders/id'])assert.equal(h.driveUrl(url),null);
});
test('retry is measured in minutes and honors server Retry-After',()=>{
 assert.equal(h.retryTime({},1,now)-now,60000);
 assert.equal(h.retryTime({},2,now)-now,300000);
 assert.equal(h.retryTime({headers:{'retry-after':'900'}},1,now)-now,900000);
 assert.equal(h.retryTime({headers:{'retry-after':new Date(now+600000).toUTCString()}},1,now)>now+590000,true);
});
test('notification has source timestamp, private inbox link, and no submitter details',()=>{
 const n=h.notification({...tip,senderName:'PRIVATE PERSON',description:'PRIVATE STORY',driveUrl:'https://drive.google.com/drive/folders/secret'},now+3600000);
 assert.equal(n.notification.title,'Tip received earlier');assert.match(n.notification.body,/Received/);assert.match(n.notification.navigate,/tip=[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(n),/PRIVATE|secret/);
});
test('capture uses server receipt time and strips client metadata',()=>{
 const o={name:'tips/2026-10-02_22-30-00_abcdefghijkl/_submission.json',timeCreated:new Date().toISOString(),metadata:{senderName:'private',notificationStatus:'sent',driveCopyStatus:'complete',driveFolderUrl:'https://drive.google.com/drive/folders/id'}};
 const t=h.tipRecord(o);assert.equal(t.receivedAt,o.timeCreated);assert.equal(t.status,'ready');assert.equal(t.senderName,undefined);assert.equal(h.tipRecord({...o,name:'_tipalerts/v1/config.json'}),null);
});
test('simultaneous triggers send a tip only once and sent records suppress repeats',async()=>{
 let sent=0;const x=harness({send:async()=>{sent++;}});
 await Promise.all([x.deliver(tip,device,keys),x.deliver(tip,device,keys)]);await x.deliver(tip,device,keys);assert.equal(sent,1);
});
test('failed push is retained for retry without waiting for a Drive copy',async()=>{
 let sent=0;const x=harness({send:async()=>{sent++;throw Object.assign(Error(),{statusCode:503});}});
 await x.deliver(tip,device,keys);await x.deliver(tip,device,keys);assert.equal(sent,1);
 const r=[...x.files.values()][0].data;assert.equal(r.status,'pending');assert.ok(r.nextAttempt<=Date.now()+60000);assert.ok(r.nextAttempt>Date.now());
});
test('expired subscriptions are disabled rather than retried forever',async()=>{
 const x=harness({send:async()=>{throw Object.assign(Error(),{statusCode:410});},initial:{['_tipalerts/v1/devices/'+device.id+'.json']:device}});
 await x.deliver(tip,device,keys);assert.equal(x.files.get('_tipalerts/v1/devices/'+device.id+'.json').data.subscription,null);
});
test('pairing does not replay historical tips or send to expired devices',async()=>{
 let sent=0;const x=harness({send:async()=>sent++});
 await x.deliver({...tip,receivedAt:new Date(now-86400000).toISOString()},device,keys);
 await x.deliver(tip,{...device,expiresAt:new Date(now-1).toISOString()},keys);assert.equal(sent,0);
});
test('pairing requires the existing administrator session verified at the fixed site',async()=>{
 let called=0;const x=harness({fetchImpl:async(url,opts)=>{called++;assert.equal(url,'https://www.chriscerney.org/api/admin-auth');assert.equal(opts.redirect,'error');return {ok:true,json:async()=>({authenticated:true})};}});
 assert.equal(await x.adminVerified({adminCookie:'cc_admin_session=test.sig',userAgent:'test'}),true);
 assert.equal(await x.adminVerified({adminCookie:'cc_admin_session=x\r\nHost: evil'}),false);assert.equal(called,1);
});
test('raw device tokens are required; expired devices cannot read the inbox',async()=>{
 const token='x'.repeat(43);const x=harness({initial:{['_tipalerts/v1/devices/'+h.hash(token)+'.json']:{...device,expiresAt:new Date(now-1).toISOString()}}});
 assert.equal(await x.authenticate(token),null);assert.equal(await x.authenticate('../config'),null);
});


test('trusted devices stay active past 90 days; expiry and revocation fail closed',()=>{
 const trusted={...device,sessionPolicy:'until-sign-out',expiresAt:null};
 assert.equal(h.activeDevice(trusted,now+500*86400000),true);
 assert.equal(h.activeDevice({...trusted,revokedAt:new Date().toISOString()}),false);
 assert.equal(h.activeDevice({...device,expiresAt:null}),false);
 assert.equal(h.activeDevice({...trusted,expiresAt:device.expiresAt}),false);
});
test('persistent authentication and push stop on explicit sign-out',async()=>{
 const token='x'.repeat(43),id=h.hash(token),path='_tipalerts/v1/devices/'+id+'.json';
 let sent=0;const trusted={...device,id,createdAt:new Date(now-200*86400000).toISOString(),sessionPolicy:'until-sign-out',expiresAt:null};
 const x=harness({send:async()=>sent++,initial:{[path]:trusted}});
 assert.equal((await x.authenticate(token)).id,id);
 await x.deliver(tip,trusted,keys);assert.equal(sent,1);
 const res={set(){},status(n){this.code=n;return this;},json(data){this.body=data;}};
 await x.handleApi({method:'POST',is:()=>true,body:{op:'logout',token}},res);
 assert.equal(res.body.authenticated,false);assert.equal(await x.authenticate(token),null);
 const revoked=x.files.get(path).data;assert.ok(revoked.revokedAt);assert.equal(revoked.subscription,null);
 await x.deliver({...tip,id:'c'.repeat(64)},revoked,keys);assert.equal(sent,1);
});


test('a stale subscription update cannot undo sign-out',async()=>{
 const id='b'.repeat(64),path='_tipalerts/v1/devices/'+id+'.json';
 const x=harness({initial:{[path]:{...device,sessionPolicy:'until-sign-out',expiresAt:null,revokedAt:new Date().toISOString(),subscription:null}}});
 await assert.rejects(x.updateDevice(id,{subscription}),e=>e.code===401);
 assert.equal(x.files.get(path).data.subscription,null);
});

test('login attempts are reserved atomically and persist across fresh server instances',async()=>{
 const x=harness(),key='a'.repeat(64);
 for(let i=0;i<8;i++)assert.equal(await x.reserveLogin(key),true);
 assert.equal(await x.reserveLogin(key),false);
 const fresh=harness({initial:Object.fromEntries([...x.files].map(([k,v])=>[k,v.data]))});
 assert.equal(await fresh.reserveLogin(key),false);
 for(let i=0;i<32;i++)assert.equal(await fresh.reserveLogin(h.hash('network-'+i)),true);
 assert.equal(await fresh.reserveLogin(h.hash('another-network')),false);
});
test('concurrent requests cannot get extra password guesses',async()=>{
 const x=harness(),key='a'.repeat(64);for(let i=0;i<7;i++)await x.reserveLogin(key);
 const results=await Promise.all(Array.from({length:5},()=>x.reserveLogin(key)));
 assert.equal(results.filter(Boolean).length,1);
});
test('remote disconnect leaves the current phone connected and invalidates the other token',async()=>{
 const token='x'.repeat(43),other='y'.repeat(43),id=h.hash(token),target=h.hash(other);
 const x=harness({initial:{['_tipalerts/v1/devices/'+id+'.json']:{...device,id,sessionPolicy:'until-sign-out',expiresAt:null},['_tipalerts/v1/devices/'+target+'.json']:{...device,id:target,sessionPolicy:'until-sign-out',expiresAt:null}}});
 const res={set(){},status(n){this.code=n;return this;},json(body){this.body=body;}};
 await x.handleApi({method:'POST',is:()=>true,body:{op:'devices',token}},res);
 assert.equal(res.body.devices.length,2);assert.doesNotMatch(JSON.stringify(res.body),/endpoint|p256dh|auth|subscription/);
 await x.handleApi({method:'POST',is:()=>true,body:{op:'revoke-device',token,id:target}},res);
 assert.equal(res.body.disconnected,true);assert.equal(await x.authenticate(other),null);assert.equal((await x.authenticate(token)).id,id);
});

test('inbox reuses listing generations, refreshes changed tips, and removes deleted tips',async()=>{
 const name='_tipalerts/v1/tips/'+tip.id+'.json';const h=harness({initial:{[name]:tip}});
 assert.equal((await h.inboxDocuments()).length,1);
 assert.deepEqual(h.counts,{metadata:0,downloads:1});
 await h.inboxDocuments();assert.equal(h.counts.downloads,1);
 h.files.set(name,{generation:2,data:{...tip,status:'ready',driveUrl:'https://drive.google.com/drive/folders/new'}});
 assert.equal((await h.inboxDocuments())[0].status,'ready');assert.equal(h.counts.downloads,2);
 h.files.delete(name);assert.equal((await h.inboxDocuments()).length,0);
});
test('device authentication always reads fresh storage even with a warm inbox cache',async()=>{
 const token='a'.repeat(43),name='_tipalerts/v1/devices/'+h.hash(token)+'.json';
 const c=harness({initial:{[name]:device}});
 assert.ok(await c.authenticate(token));
 c.files.set(name,{generation:2,data:{...device,revokedAt:new Date().toISOString()}});
 assert.equal(await c.authenticate(token),null);
 assert.deepEqual(c.counts,{metadata:0,downloads:2});
});

test('source details and verified follow-up enrich one canonical inbox record',async()=>{
 const path='tips/2026-10-04_12-00-00_abcdefghijkl/_submission.json';
 const c=harness({initial:{[path]:{whatHappened:'Original context',senderContact:'SECRET'},[path.replace('_submission.json','_context_ready.json')]:{submissionName:path,submissionGeneration:'1',receivedAt:'2026-10-04T12:01:00Z',submission:{whatHappened:'Updated context',location:'Monterey',senderName:'SECRET'}}}});
 const r=await c.syncTip({name:path,generation:1,timeCreated:'2026-10-04T12:00:00Z',metadata:{}});
 assert.equal(r.sourceTitle,'Updated context');assert.equal(r.sourceLocation,'Monterey');assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.equal([...c.files.keys()].filter(n=>n.startsWith('_tipalerts/v1/tips/')).length,1);
});

test('Drive folder opens while files copy and survives an older metadata event',async()=>{
 const path='tips/2026-10-04_12-00-00_abcdefghijkl/_submission.json';
 const c=harness({initial:{[path]:{}}});
 const event={name:path,generation:1,timeCreated:'2026-10-04T12:00:00Z',metadata:{driveFolderUrl:'https://drive.google.com/drive/folders/early',driveCopyStatus:'copying'}};
 const r=await c.syncTip(event);
 assert.equal(r.status,'processing');assert.equal(r.driveUrl,event.metadata.driveFolderUrl);
 const stale=await c.syncTip({...event,metadata:{}});
 assert.equal(stale.status,'processing');assert.equal(stale.driveUrl,r.driveUrl);
 c.files.set(path,{generation:2,data:{}});
 const replaced=await c.syncTip({...event,generation:2,metadata:{}});
 assert.equal(replaced.driveUrl,null);
});

'use strict';
const {createHmac,createHash,randomUUID}=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PUSH=/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const publicPost=(p,now)=>p?.status==='published'&&Number.isFinite(Date.parse(p.publishAt))&&Date.parse(p.publishAt)<=now;
function createPushService({store,secret,send,receipts,now=Date.now}) {
 const who=token=>/^[a-f0-9]{64}$/.test(token||'')?createHmac('sha256',secret()).update('news-push-device:'+token).digest('hex'):null;
 const deviceKey=id=>'devices/'+id+'.json';
 const eventKey=id=>'events/'+id+'.json';
 const stamp=()=>new Date(now()).toISOString();
 async function mutate(key,fn){for(let i=0;i<8;i++){const old=await store.read(key);const next=fn(old?.data);try{await store.write(key,next,old?.generation||0);return next;}catch(e){if(Number(e.code)!==412||i===7)throw e;}}}
 async function limit(key,max,period){await mutate('limits/'+hash(key)+'.json',old=>{const r=old&&old.until>now()?old:{count:0,until:now()+period};if(r.count>=max)fail(429,'Please wait a few minutes before trying again.');return {...r,count:r.count+1};});}
 function status(d){return {enabled:!!(d?.enabled&&d.token),reports:d?.reports??true,breaking:d?.breaking??true,lastTest:d?.lastTest?{state:d.lastTest.state,error:d.lastTest.error||null,at:d.lastTest.at}:null};}
 async function recordTicket(d,key,message){
  const lease=randomUUID();let claimed=false;
  await mutate(key,old=>{claimed=false;if(old)return old;claimed=true;return {deviceId:d.id,tokenHash:hash(d.token),eventId:message.data.eventId,state:'sending',at:stamp(),lease};});
  if(!claimed)return null;
  let result;
  try {result=await send(message);}
  catch {result={status:'unknown',details:{error:'ConnectionInterrupted'}};}
  const state=result?.status==='ok'&&typeof result.id==='string'?'queued':result?.status==='error'?'failed':'unconfirmed';
  const error=state==='failed'?String(result.details?.error||'ProviderError').slice(0,60):state==='unconfirmed'?'ConnectionInterrupted':null;
  const saved=await mutate(key,old=>old?.lease===lease?{...old,state,ticketId:state==='queued'?result.id:null,error}:old);
  if(state==='queued')await mutate('receipts/'+result.id+'.json',old=>old||saved);
  if(error==='DeviceNotRegistered')await mutate(deviceKey(d.id),old=>old?.token===d.token?{...old,enabled:false,token:null}:old);
  return saved;
 }
 async function handle(body,context={}){
  const id=who(context.token),op=body?.op;
  if(typeof op!=='string')fail(400,'Invalid request.');
  if(op.startsWith('admin-')&&context.admin!==true)fail(401,'Sign in as the administrator.');
  if(op==='admin-send'){
   if(!UUID.test(body.storyId||'')||!UUID.test(body.requestId||'')||body.confirm!==true)fail(400,'Choose a published story and confirm the alert.');
   const post=(await store.catalog()).posts.find(p=>p.id===body.storyId);
   if(!publicPost(post,now()))fail(404,'This story is not public.');
   const event={id:'breaking-'+body.requestId,kind:'breaking',storyId:post.id,title:String(post.title).slice(0,180),createdAt:now(),expiresAt:now()+2*3600000};
   const saved=await mutate(eventKey(event.id),old=>old||event);
   if(saved.storyId!==post.id)fail(409,'Alert request already used.');
   return {queued:true,eventId:saved.id};
  }
  if(op==='admin-status'){
   const devices=await store.list('devices/'),events=(await store.list('events/')).slice().sort((a,b)=>b.createdAt-a.createdAt).slice(0,20),summaries=[];
   for(const e of events){const rows=await store.list('deliveries/'+e.id+'/');summaries.push({id:e.id,title:e.title,kind:e.kind,at:new Date(e.createdAt).toISOString(),queued:rows.filter(d=>d.state==='queued').length,accepted:rows.filter(d=>d.state==='accepted').length,failed:rows.filter(d=>['failed','unconfirmed'].includes(d.state)).length});}
   return {subscribers:devices.filter(d=>d.enabled&&d.token).length,events:summaries};
  }
  if(!id)fail(401,'This device could not be identified.');
  if(op==='status')return status((await store.read(deviceKey(id)))?.data);
  if(op==='register'){
   if(body.consent!==true||body.platform!=='ios'||!PUSH.test(body.pushToken||'')||typeof body.reports!=='boolean'||typeof body.breaking!=='boolean'||(!body.reports&&!body.breaking))fail(400,'Choose at least one notification type and allow notifications.');
   await limit('register:'+context.clientKey,60,3600000);
   await mutate(deviceKey(id),old=>({id,token:body.pushToken,enabled:true,reports:body.reports,breaking:body.breaking,reportsAfter:old?.enabled&&old?.reports?old.reportsAfter:now(),breakingAfter:old?.enabled&&old?.breaking?old.breakingAfter:now(),createdAt:old?.createdAt||stamp(),updatedAt:stamp(),lastTest:old?.lastTest||null}));
   await mutate('tokens/'+hash(body.pushToken)+'.json',()=>({deviceId:id}));
   return status((await store.read(deviceKey(id))).data);
  }
  if(op==='disable'){
   const d=await mutate(deviceKey(id),old=>({...old,id,enabled:false,token:null,updatedAt:stamp()}));return status(d);
  }
  if(op==='test'){
   const d=(await store.read(deviceKey(id)))?.data;
   if(!d?.enabled||!d.token)fail(400,'Enable notifications on this device first.');
   await limit('test:'+id,2,10*60000);await limit('test-network:'+context.clientKey,10,3600000);
   const eventId='test-'+randomUUID();
   const ticket=await recordTicket(d,'deliveries/'+eventId+'/'+id+'.json',{to:d.token,title:'Cerney News',body:'Your test notification is connected. Tap to open notification settings.',sound:'default',channelId:'news-reports',data:{screen:'notifications',eventId},ttl:120});
   await mutate(deviceKey(id),old=>({...old,lastTest:{state:ticket.state,error:ticket.error,ticketId:ticket.ticketId,at:stamp()}}));
   return status((await store.read(deviceKey(id))).data);
  }
  fail(400,'Unknown request.');
 }
 async function drain(){
  const catalog=await store.catalog();
  for(const post of catalog.posts.filter(p=>publicPost(p,now())&&p.notify===true&&p.media?.some(m=>String(m.type).startsWith('video/'))&&now()-Date.parse(p.publishAt)<6*3600000)){
   const event={id:'report-'+post.id,kind:'reports',storyId:post.id,title:String(post.title).slice(0,180),createdAt:Date.parse(post.publishAt),expiresAt:Date.parse(post.publishAt)+6*3600000};
   await mutate(eventKey(event.id),old=>old||event);
  }
  const [events,devices]=await Promise.all([store.list('events/'),store.list('devices/')]);let queued=0,attempted=0;
  for(const event of events.filter(e=>e.expiresAt>now()).sort((a,b)=>a.createdAt-b.createdAt)){
   const live=catalog.posts.find(p=>p.id===event.storyId);
   if(!publicPost(live,now())||(event.kind==='reports'&&live.notify!==true))continue;
   for(const candidate of devices){
    if(attempted>=100)break;
    if(!candidate.enabled||!candidate.token||!candidate[event.kind]||event.createdAt<(candidate[event.kind+'After']||Infinity))continue;
    const d=(await store.read(deviceKey(candidate.id)))?.data;
    if(!d?.enabled||!d.token||!d[event.kind]||event.createdAt<(d[event.kind+'After']||Infinity))continue;
    const owner=(await store.read('tokens/'+hash(d.token)+'.json'))?.data;
    if(owner?.deviceId!==d.id)continue;
    const key='deliveries/'+event.id+'/'+d.id+'.json';
    if(await store.read(key))continue;
    const ticket=await recordTicket(d,key,{to:d.token,title:event.kind==='breaking'?'Cerney News · Breaking update':'Cerney News · New report',body:event.title,sound:'default',channelId:event.kind==='breaking'?'breaking-news':'news-reports',priority:event.kind==='breaking'?'high':'default',data:{storyId:event.storyId,eventId:event.id},ttl:event.kind==='breaking'?3600:14400});
    if(ticket){attempted++;if(ticket.state==='queued')queued++;}
   }
  }
  await checkReceipts();
  return {queued,attempted};
 }
 async function checkReceipts(){
  const pending=(await store.list('receipts/')).filter(d=>d.state==='queued'&&d.ticketId&&now()-Date.parse(d.at)>=10000).sort((a,b)=>a.at.localeCompare(b.at)).slice(0,100);
  if(!pending.length)return;
  const results=await receipts(pending.map(d=>d.ticketId));
  for(const d of pending){
   const r=results[d.ticketId];if(!r&&now()-Date.parse(d.at)<45*60000)continue;
   const state=!r?'unconfirmed':r.status==='ok'?'accepted':'failed',error=!r?'ReceiptUnavailable':r.status==='error'?String(r.details?.error||'ProviderError').slice(0,60):null;
   const key='deliveries/'+d.eventId+'/'+d.deviceId+'.json';
   await mutate(key,old=>({...old,state,error,receiptAt:stamp()}));
   const device=(await store.read(deviceKey(d.deviceId)))?.data;
   if(device?.lastTest?.ticketId===d.ticketId)await mutate(deviceKey(d.deviceId),old=>old?.lastTest?.ticketId===d.ticketId?{...old,lastTest:{...old.lastTest,state,error}}:old);
   if(error==='DeviceNotRegistered')await mutate(deviceKey(d.deviceId),old=>old?.token&&hash(old.token)===d.tokenHash?{...old,enabled:false,token:null}:old);
   await store.remove('receipts/'+d.ticketId+'.json');
  }
 }
 return {handle,drain,checkReceipts};
}
module.exports={createPushService};

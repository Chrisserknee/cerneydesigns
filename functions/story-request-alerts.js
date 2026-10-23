'use strict';
const {randomUUID}=require('node:crypto');
const {storyRequest}=require('./story-request-record');
const {SITE,activeDevice,retryTime,pushNotification}=require('./tip-alerts-helpers');
const BUCKET='tip-line-8c2d7.firebasestorage.app',ROOT='_tipalerts/v1/';
function payload(story){const url=SITE+'/tip-alerts/?story='+story.id;return pushNotification({title:'Story request ready',body:'A witness callout is ready. Review the image and wording in Cerney Tips.',navigate:url,tag:'story-request-'+story.id,icon:SITE+'/tip-alerts/icon-192.png',data:{url}});}
function createAlerts({read,write,documents,send,config,logger={info(){},warn(){}}}){
 async function deliver(story,device,keys){
  if(!story?.notify || !device.subscription || !activeDevice(device) || !Number.isFinite(Date.parse(device.subscribedAt)) || !Number.isFinite(Date.parse(keys.enabledAt))
     || Date.parse(story.createdAt)<Math.max(Date.parse(device.subscribedAt),Date.parse(keys.enabledAt)))return;
  // One notification per incident and device, even after wording/source updates.
  const name=`story-request-deliveries/${story.id}-${device.id}.json`,old=await read(name),now=Date.now();
  if(old?.data.status==='sent' || Number(old?.data.nextAttempt||0)>now)return;
  const lease=randomUUID(),attempt=(old?.data.attempt||0)+1,base={id:story.id,deviceId:device.id,attempt,lease};
  try{await write(name,{...base,status:'sending',nextAttempt:now+120000},old?.generation||0);}catch(e){if(e.code===412)return;throw e;}
  const fresh=storyRequest((await read(`story-requests/${story.id}.json`))?.data),d=await read(`devices/${device.id}.json`);
  if(!fresh?.notify || !activeDevice(d?.data) || d.data.subscription?.endpoint!==device.subscription.endpoint)return;
  try{
   await send(device.subscription,payload(fresh),keys);
   const current=await read(name);if(current?.data.lease!==lease)return;
   await write(name,{...base,status:'sent',acceptedAt:new Date().toISOString()},current.generation);
   logger.info('Story request push accepted',{id:story.id});
  }catch(e){
   const current=await read(name);if(current?.data.lease!==lease)return;
   if([404,410].includes(e.statusCode)){
    const d=await read(`devices/${device.id}.json`);
    if(d?.data.subscription?.endpoint===device.subscription.endpoint){try{await write(`devices/${device.id}.json`,{...d.data,subscription:null,pushExpiredAt:new Date().toISOString()},d.generation);}catch(err){if(err.code!==412)throw err;}}
    await write(name,{...base,status:'expired',nextAttempt:now+86400000},current.generation);
   }else{await write(name,{...base,status:'pending',lastStatus:Number(e.statusCode)||0,nextAttempt:retryTime(e,attempt,now)},current.generation);}
  }
 }
 async function capture(event){
  const o=event.data;if(o?.bucket!==BUCKET || !/^_tipalerts\/v1\/story-requests\/[a-f0-9]{64}\.json$/.test(o.name||''))return;
  const stored=await read(o.name.slice(ROOT.length));if(!stored || String(stored.generation)!==String(o.generation))return;
  const s=storyRequest(stored.data);if(!s || o.name!==ROOT+`story-requests/${s.id}.json`)return;
  const keys=await config();for(const d of await documents('devices/'))await deliver(s,d,keys);
 }
 async function retry(){
  const devices=(await documents('devices/')).filter(d=>d.subscription&&activeDevice(d));if(!devices.length)return;
  const keys=await config();for(const data of await documents('story-requests/')){const s=storyRequest(data);if(s)for(const d of devices)await deliver(s,d,keys);}
 }
 return {capture,retry,deliver};
}
module.exports={BUCKET,ROOT,payload,createAlerts};

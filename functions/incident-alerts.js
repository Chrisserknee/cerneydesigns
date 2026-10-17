'use strict';
const {randomUUID}=require('node:crypto');
const {incidentRecord}=require('./incident-record');
const {SITE,activeDevice,retryTime,pushNotification}=require('./tip-alerts-helpers');
// First report-alert acceptance run; never reset this on a later deployment.
const ENABLED_AT='2026-10-17T10:10:00.000Z';
const BUCKET='tip-line-8c2d7.firebasestorage.app';
const ROOT='_tipalerts/v1/';
function alertRecord(data,now=Date.now()){
 const card=incidentRecord(data),at=Date.parse(data?.updatedAt);
 if(!card || at<Date.parse(ENABLED_AT) || at>now+60000 || at<now-7*86400000)return null;
 return {...card,receivedAt:data.updatedAt,alertState:card.reportState==='needs_review'?'review':'ready'};
}
function payload(report){
 const url=`${SITE}/tip-alerts/?tip=${report.id}`;
 return pushNotification({title:report.alertState==='review'?'Report needs your review':'Video report ready',body:'Open Cerney Tips for the video, full Instagram description and VO.',navigate:url,tag:`report-${report.id}-r${report.reportRevision}-${report.alertState}`,icon:SITE+'/tip-alerts/icon-192.png',data:{url}});
}
function createAlerts({read,write,documents,send,config,logger={info(){},warn(){}}}){
 async function deliver(report,device,keys){
  if(!report || !device.subscription || !activeDevice(device) || !Number.isFinite(Date.parse(device.subscribedAt)) || !Number.isFinite(Date.parse(keys.enabledAt)) || Date.parse(report.receivedAt)<Math.max(Date.parse(keys.enabledAt),Date.parse(device.subscribedAt)))return;
  const name=`incident-alert-deliveries/${report.id}-r${report.reportRevision}-${report.alertState}-${device.id}.json`;
  const previous=await read(name),now=Date.now();
  if(previous?.data.status==='sent' || Number(previous?.data.nextAttempt||0)>now)return;
  const lease=randomUUID(),attempt=(previous?.data.attempt||0)+1;
  const base={id:report.id,revision:report.reportRevision,reportState:report.alertState,deviceId:device.id,attempt,lease};
  try{await write(name,{...base,status:'sending',nextAttempt:now+120000},previous?.generation||0);}catch(e){if(e.code===412)return;throw e;}
  // Check revocation and current report again immediately before sending.
  const currentDevice=await read(`devices/${device.id}.json`);
  const currentReport=alertRecord((await read(`incidents/${report.id}.json`))?.data);
  if(!activeDevice(currentDevice?.data) || currentDevice.data.subscription?.endpoint!==device.subscription.endpoint || !currentReport || currentReport.reportRevision!==report.reportRevision || currentReport.alertState!==report.alertState)return;
  try{
   await send(device.subscription,payload(report),keys);
   const current=await read(name);if(current?.data.lease!==lease)return;
   await write(name,{...base,status:'sent',acceptedAt:new Date().toISOString()},current.generation);
   logger.info('Incident report push accepted',{id:report.id,revision:report.reportRevision});
  }catch(e){
   const current=await read(name);if(current?.data.lease!==lease)return;
   if(e.statusCode===404 || e.statusCode===410){
    const d=await read(`devices/${device.id}.json`);
    if(d?.data.subscription?.endpoint===device.subscription.endpoint){try{await write(`devices/${device.id}.json`,{...d.data,subscription:null,pushExpiredAt:new Date().toISOString()},d.generation);}catch(err){if(err.code!==412)throw err;}}
    await write(name,{...base,status:'expired',nextAttempt:now+86400000},current.generation);
   }else{
    await write(name,{...base,status:'pending',lastStatus:Number(e.statusCode)||0,nextAttempt:retryTime(e,attempt,now)},current.generation);
    logger.warn('Incident report push queued for retry',{id:report.id,status:Number(e.statusCode)||0});
   }
  }
 }
 async function capture(event){
  const o=event.data;
  if(o?.bucket!==BUCKET || !/^_tipalerts\/v1\/incidents\/[a-f0-9]{64}\.json$/.test(o.name||''))return;
  const stored=await read(o.name.slice(ROOT.length));
  if(!stored || String(stored.generation)!==String(o.generation))return;
  const report=alertRecord(stored.data);
  if(!report || o.name!==ROOT+`incidents/${report.id}.json`)return;
  const keys=await config(),devices=await documents('devices/');
  await Promise.all(devices.map(d=>deliver(report,d,keys)));
 }
 async function retry(){
  const devices=(await documents('devices/')).filter(d=>d.subscription&&activeDevice(d));
  if(!devices.length)return;
  const keys=await config(),reports=(await documents('incidents/')).map(d=>alertRecord(d)).filter(Boolean);
  for(const report of reports)for(const device of devices)await deliver(report,device,keys);
 }
 return {deliver,capture,retry};
}
module.exports={ENABLED_AT,BUCKET,ROOT,alertRecord,payload,createAlerts};

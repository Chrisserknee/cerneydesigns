'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {activeDevice,notification,retryTime}=require('./tip-alerts-helpers');
const {TOPIC,validToken}=require('./apns-transport');
const validRegistration=p=>p?.bundleID===TOPIC && validToken(p.token) && ['sandbox','production'].includes(p.environment) && Number.isFinite(Date.parse(p.registeredAt));
function nativePayload(tip,now=Date.now()){
 const message=notification(tip,now).notification;
 return {aps:{alert:{title:message.title,body:message.body.replace(/\s*Open Cerney Tips → Inbox\.$/,'')},sound:'default','thread-id':'tips'},type:'tip',tipID:tip.id};
}
const testPayload=()=>({aps:{alert:{title:'Cerney Tips · test',body:'Native tip alerts are working. Tap to open Cerney Tips.'},sound:'default','thread-id':'tips'},type:'test'});
function nativeDevices(devices){
 const unique=new Map();
 for(const device of devices){
  if(!activeDevice(device) || !validRegistration(device.nativePush))continue;
  const key=device.nativePush.environment+':'+device.nativePush.token.toLowerCase(),previous=unique.get(key);
  if(!previous || device.nativePush.registeredAt>previous.nativePush.registeredAt)unique.set(key,device);
 }
 return [...unique.values()];
}
function createNativePush({read,write,updateDevice,send,ready,now=Date.now}){
 const bindingName=p=>'native-bindings/'+createHash('sha256').update(p.environment+':'+p.token.toLowerCase()).digest('hex')+'.json';
 async function release(device){
  if(!validRegistration(device.nativePush))return;
  const name=bindingName(device.nativePush),binding=await read(name);
  if(binding?.data.deviceId===device.id){try{await write(name,{deviceId:null},binding.generation);}catch(e){if(e.code!==412)throw e;}}
 }
 function status(device){return {configured:ready(),subscribed:activeDevice(device)&&validRegistration(device.nativePush),environment:device.nativePush?.environment||null,testAcceptedAt:device.lastNativeTestAt||null};}
 async function expire(device){
  const current=await read(`devices/${device.id}.json`);
  if(activeDevice(current?.data) && current.data.nativePush?.token===device.nativePush.token && current.data.nativePush?.environment===device.nativePush.environment){
   try{await write(`devices/${device.id}.json`,{...current.data,nativePush:null,nativePushExpiredAt:new Date(now()).toISOString()},current.generation);}catch(e){if(e.code!==412)throw e;}
  }
 }
 async function handle(body,device){
  if(body.op==='native-status')return status(device);
  if(body.op==='native-unregister'){await release(device);await updateDevice(device.id,{nativePush:null,nativePushDisabledAt:new Date(now()).toISOString()});return status({...device,nativePush:null});}
  if(!ready())throw Object.assign(Error('Native alerts are not configured yet.'),{code:503});
  if(body.op==='native-register'){
   if(!validToken(body.deviceToken) || !['production','sandbox'].includes(body.environment) || body.bundleID!==TOPIC)throw Object.assign(Error('This iPhone push registration is invalid.'),{code:400});
   const same=validRegistration(device.nativePush)&&device.nativePush.token===body.deviceToken.toLowerCase()&&device.nativePush.environment===body.environment;
   const nativePush={bundleID:TOPIC,token:body.deviceToken.toLowerCase(),environment:body.environment,registeredAt:same?device.nativePush.registeredAt:new Date(now()).toISOString(),lastSeenAt:new Date(now()).toISOString()};
   if(validRegistration(device.nativePush)&&!same)await release(device);
   await updateDevice(device.id,{nativePush,nativePushExpiredAt:null});
   // One installation belongs to its latest sign-in. Signing out or disabling
   // must never reactivate an older paired session with the same APNs token.
   await write(bindingName(nativePush),{deviceId:device.id,registeredAt:nativePush.registeredAt});
   return status({...device,nativePush});
  }
  if(body.op==='native-test'){
   if(!validRegistration(device.nativePush))throw Object.assign(Error('Enable tip alerts on this iPhone first.'),{code:409});
   if((await read(bindingName(device.nativePush)))?.data.deviceId!==device.id)throw Object.assign(Error('Enable tip alerts in your latest iPhone sign-in.'),{code:409});
   if(now()-Date.parse(device.lastNativeTestAt||0)<10000)throw Object.assign(Error('Please wait a few seconds before another test.'),{code:429});
   try{
    const result=await send(device.nativePush,testPayload());
    await updateDevice(device.id,{lastNativeTestAt:result.acceptedAt});
    return {...status(device),testAcceptedAt:result.acceptedAt};
   }catch(e){
    if(e.statusCode===410 || e.reason==='BadDeviceToken'){await expire(device);throw Object.assign(Error('This iPhone needs to reconnect its alerts. Tap Enable again.'),{code:409});}
    throw e;
   }
  }
  throw Object.assign(Error('Unknown native alert request.'),{code:400});
 }
 async function deliver(tip,device){
  if(!ready() || !activeDevice(device) || !validRegistration(device.nativePush) || !/^[a-f0-9]{64}$/.test(tip?.id||''))return;
  const received=Date.parse(tip.receivedAt);
  if(!Number.isFinite(received) || received<Date.parse(device.nativePush.registeredAt) || now()-received>86400000)return;
  const name=`native-deliveries/${tip.id}-${device.id}.json`,previous=await read(name);
  if(['sent','expired'].includes(previous?.data.status) || Number(previous?.data.nextAttempt||0)>now())return;
  const attempt=(previous?.data.attempt||0)+1;
  try{await write(name,{tipId:tip.id,deviceId:device.id,status:'sending',attempt,lease:randomUUID(),nextAttempt:now()+120000},previous?.generation||0);}
  catch(e){if(e.code===412)return;throw e;}
  try{
   // Recheck revocation/token rotation immediately before contacting Apple.
   const current=await read(`devices/${device.id}.json`);
   const binding=await read(bindingName(device.nativePush));
   if(binding?.data.deviceId!==device.id || !activeDevice(current?.data) || current.data.nativePush?.token!==device.nativePush.token || current.data.nativePush?.environment!==device.nativePush.environment){
    await write(name,{tipId:tip.id,deviceId:device.id,status:'expired',attempt});return;
   }
   const result=await send(device.nativePush,nativePayload(tip,now()),tip.id);
   await write(name,{tipId:tip.id,deviceId:device.id,status:'sent',attempt,acceptedAt:result.acceptedAt});
  }catch(e){
   const permanent=e.statusCode===410 || e.reason==='BadDeviceToken';
   if(permanent)await expire(device);
   await write(name,{tipId:tip.id,deviceId:device.id,status:permanent?'expired':'pending',attempt,lastStatus:Number(e.statusCode)||0,nextAttempt:retryTime(e,attempt,now())});
  }
 }
 return {handle,deliver,status};
}
module.exports={validRegistration,nativePayload,testPayload,nativeDevices,createNativePush};

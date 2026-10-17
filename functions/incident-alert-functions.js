'use strict';
const {getStorage}=require('firebase-admin/storage');
const {onObjectFinalized}=require('firebase-functions/v2/storage');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {logger}=require('firebase-functions');
const webpush=require('web-push');
const {SITE}=require('./tip-alerts-helpers');
const {BUCKET,ROOT,createAlerts}=require('./incident-alerts');
const bucket=()=>getStorage().bucket(BUCKET);
async function read(name){
 try{const [m]=await bucket().file(ROOT+name).getMetadata();if(Number(m.size)>65536)throw Error('Report alert record exceeds limit');const [b]=await bucket().file(ROOT+name,{generation:m.generation}).download();return {data:JSON.parse(b.toString()),generation:m.generation};}catch(e){if(e.code===404)return null;throw e;}
}
async function write(name,data,generation){await bucket().file(ROOT+name).save(JSON.stringify(data),{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:generation}});}
async function documents(prefix){const [files]=await bucket().getFiles({prefix:ROOT+prefix});return (await Promise.all(files.map(f=>read(f.name.slice(ROOT.length))))).filter(Boolean).map(r=>r.data);}
const alerts=createAlerts({read,write,documents,logger,config:async()=>{const c=await read('config.json');if(!c)throw Error('Existing tip alert configuration unavailable');return c.data;},send:(subscription,payload,keys)=>webpush.sendNotification(subscription,JSON.stringify(payload),{TTL:86400,urgency:'high',timeout:15000,vapidDetails:{subject:SITE+'/tip-alerts/',publicKey:keys.publicKey,privateKey:keys.privateKey}})});
const options={region:'us-west1',memory:'256MiB',timeoutSeconds:120,maxInstances:3};
exports.captureIncidentReport=onObjectFinalized({...options,bucket:BUCKET,retry:true},alerts.capture);
exports.retryIncidentReports=onSchedule({...options,maxInstances:1,schedule:'every 5 minutes'},alerts.retry);

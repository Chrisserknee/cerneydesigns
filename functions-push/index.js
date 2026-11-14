'use strict';
const {initializeApp}=require('firebase-admin/app');
const {getStorage}=require('firebase-admin/storage');
const {onRequest}=require('firebase-functions/v2/https');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret}=require('firebase-functions/params');
const {createHmac,timingSafeEqual}=require('node:crypto');
const {createPushService}=require('./core');
initializeApp();
const proxySecret=defineSecret('TIP_ALERTS_PROXY_SECRET');
const bucket=()=>getStorage().bucket('tip-line-8c2d7.firebasestorage.app'),ROOT='_news/push-v1/';
async function readPath(path){try{const [m]=await bucket().file(path).getMetadata();const [b]=await bucket().file(path,{generation:m.generation}).download();return {data:JSON.parse(b.toString()),generation:m.generation};}catch(e){if(Number(e.code)===404)return null;throw e;}}
const store={
 read:key=>readPath(ROOT+key),
 async write(key,data,generation){const raw=JSON.stringify(data);if(Buffer.byteLength(raw)>512*1024)throw new Error('Record too large');await bucket().file(ROOT+key).save(raw,{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:generation}});},
 async remove(key){await bucket().file(ROOT+key).delete({ignoreNotFound:true});},
 async catalog(){return (await readPath('_news/v1/catalog.json'))?.data||{posts:[]};},
 async list(prefix){const result=[];let q={prefix:ROOT+prefix,maxResults:200,autoPaginate:false};while(q){const [files,next]=await bucket().getFiles(q);if(result.length+files.length>5000)throw new Error('Record scan limit');for(let i=0;i<files.length;i+=20){const rows=await Promise.all(files.slice(i,i+20).map(f=>readPath(f.name)));result.push(...rows.filter(Boolean).map(r=>r.data));}q=next;}return result;}
};
async function expo(path,body){const r=await fetch('https://exp.host/--/api/v2/push/'+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('Push provider unavailable');const data=await r.json();if(data.errors)throw new Error('Push provider unavailable');return data.data;}
const service=createPushService({store,secret:()=>proxySecret.value(),send:async message=>{const r=await expo('send',message);return Array.isArray(r)?r[0]:r;},receipts:ids=>expo('getReceipts',{ids})});
function signed(req){const t=String(req.get('x-tip-timestamp')||''),s=String(req.get('x-tip-signature')||'');if(!/^\d{13}$/.test(t)||Math.abs(Date.now()-Number(t))>60000||!/^[a-f0-9]{64}$/.test(s))return false;return timingSafeEqual(createHmac('sha256',proxySecret.value()).update(t+'.').update(req.rawBody).digest(),Buffer.from(s,'hex'))&&req.body?.scope==='push-v1';}
const options={region:'us-west1',memory:'256MiB',maxInstances:2,timeoutSeconds:120,secrets:[proxySecret]};
exports.newsPush=onRequest({...options,invoker:'public'},async(req,res)=>{
 res.set('Cache-Control','no-store');const origin=req.get('Origin');
 if(origin&&!['https://www.chriscerney.org','http://localhost:8081','http://127.0.0.1:8081'].includes(origin))return res.status(403).json({error:'Request origin not allowed.'});
 if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}
 if(req.method==='OPTIONS'){res.set('Access-Control-Allow-Methods','POST');res.set('Access-Control-Allow-Headers','Content-Type, Authorization');return res.status(204).end();}
 if(req.method!=='POST')return res.status(405).json({error:'Use POST.'});
 if(!req.is('application/json')||!req.body||Array.isArray(req.body)||req.rawBody?.length>8192)return res.status(400).json({error:'Invalid request.'});
 const token=/^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization')||'')?.[1];
 const admin=typeof req.body.op==='string'&&req.body.op.startsWith('admin-')&&signed(req);
 const clientKey=createHmac('sha256',proxySecret.value()).update('push-ip:'+req.ip).digest('hex');
 try{return res.json(await service.handle(req.body,{token,admin,clientKey}));}catch(e){const s=[400,401,403,404,409,429].includes(e.status)?e.status:503;return res.status(s).json({error:s===503?'Notifications could not connect. Please try again.':e.message});}
});
exports.deliverNewsPush=onSchedule({...options,schedule:'every 2 minutes',timeZone:'America/Los_Angeles'},()=>service.drain());

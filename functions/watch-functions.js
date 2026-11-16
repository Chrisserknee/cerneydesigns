'use strict';
// Separate function and secret for Watch ingestion so the collector key never
// reaches tipAlertsApi and tip/production triggers ignore every watch/ write.
const {onRequest}=require('firebase-functions/v2/https');
const {defineSecret}=require('firebase-functions/params');
const {getStorage}=require('firebase-admin/storage');
const {logger}=require('firebase-functions');
const {createWatchIngest}=require('./watch-ingest');
const ingestKey=defineSecret('WATCH_INGEST_KEY');
const ROOT='_tipalerts/v1/';
const bucket=()=>getStorage().bucket('tip-line-8c2d7.firebasestorage.app');
async function read(name){
 if(!name.startsWith('watch/'))throw Object.assign(Error('Watch reader is limited to watch/'),{code:500});
 const file=bucket().file(ROOT+name);
 try{
  const [meta]=await file.getMetadata();
  if(Number(meta.size)>12*1024*1024)throw Object.assign(Error('Watch state too large'),{code:507});
  const [bytes]=await bucket().file(ROOT+name,{generation:meta.generation}).download();
  return {data:JSON.parse(bytes.toString()),generation:meta.generation};
 }catch(e){if(e.code===404)return null;throw e;}
}
async function write(name,data,generation){
 await bucket().file(ROOT+name).save(JSON.stringify(data),{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},
  ...(generation===undefined?{}:{preconditionOpts:{ifGenerationMatch:generation}})});
}
const ingest=createWatchIngest({read,write,secret:()=>ingestKey.value(),log:entry=>logger.info('Watch batch applied',entry)});
exports.watchIngestApi=onRequest({region:'us-west1',memory:'256MiB',timeoutSeconds:60,maxInstances:1,concurrency:1,invoker:'public',secrets:[ingestKey]},async(req,res)=>{
 try{return await ingest(req,res);}
 catch(e){logger.error('Watch ingest failed',{code:Number(e.code||e.statusCode)||0});return res.status(503).json({error:'unavailable'});}
});

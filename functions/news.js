'use strict';
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const {getStorage} = require('firebase-admin/storage');
const {GoogleAuth} = require('google-auth-library');
const {gatewayAuthenticated} = require('./request-auth');
const {createNewsService,SITE} = require('./news-core');
const {createNewsMediaHandler}=require('./news-media');
const {assetPath,createRenditionReader,decorateVideoPost}=require('./news-video-delivery');
const proxySecret=defineSecret('TIP_ALERTS_PROXY_SECRET');
const emailSecret=defineSecret('SPONSORSHIP_RESEND_API_KEY');
const ROOT='_news/v1/';
const BUCKET='tip-line-8c2d7.firebasestorage.app';
const bucket=()=>getStorage().bucket(BUCKET);
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/devstorage.read_write']});
const options={region:'us-west1',memory:'256MiB',maxInstances:3,timeoutSeconds:120};
const store={
    async read(name) {
        try {
            const [metadata]=await bucket().file(ROOT+name).getMetadata();
            const [data]=await bucket().file(ROOT+name,{generation:metadata.generation}).download();
            return {data:JSON.parse(data.toString()),generation:metadata.generation};
        } catch(error) { if (Number(error.code)===404) return null; throw error; }
    },
    async write(name,data,generation) {
        const json=JSON.stringify(data);
        if (Buffer.byteLength(json)>12*1024**2) throw new Error('News record limit reached');
        await bucket().file(ROOT+name).save(json,{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},
            ...(generation===undefined ? {} : {preconditionOpts:{ifGenerationMatch:generation}})});
    },
    async list(prefix) {
        const result=[];
        let query={prefix:ROOT+prefix,maxResults:200,autoPaginate:false};
        while (query) {
            const [files,next]=await bucket().getFiles(query);
            if (result.length+files.length>5000) throw new Error('News record list limit reached');
            const records=await Promise.all(files.map(file=>store.read(file.name.slice(ROOT.length))));
            result.push(...records.filter(Boolean).map(record=>record.data));
            query=next;
        }
        return result;
    }
};
const media={
    async begin(record) {
        const client=await auth.getClient();
        const name=ROOT+'media/'+record.id;
        const result=await client.request({url:`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&ifGenerationMatch=0&name=${encodeURIComponent(name)}`,
            method:'POST',headers:{Origin:SITE,'X-Upload-Content-Type':record.type,'X-Upload-Content-Length':String(record.size)},
            data:{name,contentType:record.type,cacheControl:'private,no-store'},timeout:15000});
        const uri=result.headers.location;
        if (typeof uri!=='string' || !uri.startsWith('https://storage.googleapis.com/upload/')) throw new Error('Upload session unavailable');
        return uri;
    },
    async inspect(id) { const [metadata]=await bucket().file(ROOT+'media/'+id).getMetadata(); return metadata; }
};
async function sendEmail(job) {
    const response=await fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:'Bearer '+emailSecret.value(),'Content-Type':'application/json','Idempotency-Key':job.key},
        body:JSON.stringify({from:'Chris Cerney <news@bookings.chriscerney.org>',reply_to:'cerneymedia@gmail.com',to:[job.to],subject:job.subject,text:job.text})});
    if (!response.ok) throw new Error('Email was not accepted');
    const receipt=await response.json();
    if (typeof receipt.id!=='string') throw new Error('Email receipt unavailable');
}
const readRenditions=createRenditionReader({read:name=>store.read(name)});
const service=createNewsService({store,media,sendEmail,secret:()=>proxySecret.value(),decoratePost:decorateVideoPost(readRenditions)});

exports.newsApi=onRequest({...options,secrets:[proxySecret,emailSecret],invoker:'public'},async(req,res)=>{
    res.set('Cache-Control','no-store');
    if (req.method!=='POST' || !req.is('application/json') || req.rawBody?.length>64*1024) return res.status(400).json({error:'Invalid request.'});
    if (!gatewayAuthenticated(req,proxySecret.value()) || req.body?.scope!=='news-v1') return res.status(401).json({error:'Unauthorized.'});
    try { return res.json(await service.handle(req.body)); }
    catch(error) {
        const status=[400,401,403,404,409,413,429].includes(error.status) ? error.status : 503;
        // Never return provider errors, email addresses, upload session URIs or storage paths.
        return res.status(status).json({error:status===503 ? 'The news service is temporarily unavailable. Please try again.' : error.message});
    }
});
exports.newsMedia=onRequest({...options,secrets:[proxySecret],invoker:'public'},createNewsMediaHandler({
    catalog:()=>service.catalog(),
    readUpload:async id=>(await store.read('uploads/'+id+'.json'))?.data,
    fileFor:record=>bucket().file(ROOT+'media/'+record.id,record.generation ? {generation:record.generation} : {}),
    previewSecret:()=>proxySecret.value(),
    readRenditions,
    fileForRendition:(record,level)=>bucket().file(assetPath(record,level),{generation:level.generation})
}));

exports.sendNewsUpdates=onSchedule({...options,schedule:'every 5 minutes',secrets:[proxySecret,emailSecret]},()=>service.deliverUpdates());

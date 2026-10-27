'use strict';
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(require.resolve('../tip-alerts/producer-drafts.js'));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/module.js'?'text/javascript':'text/html');res.end(req.url==='/module.js'?source:'<!doctype html><script src="/module.js"></script>');});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async()=>{
   const scope='f'.repeat(64),a=await CerneyProducerDrafts.open(scope),b=await CerneyProducerDrafts.open(scope);
   const request={id:'a'.repeat(64),requestID:'b'.repeat(64),text:'First saved instruction'};
   await a.queue(request);let conflict=false;try{await b.queue({...request,requestID:'c'.repeat(64),text:'Second tab'});}catch{conflict=true;}
   const kept=await b.pending();await b.complete({...request,requestID:'c'.repeat(64)});const notCleared=await a.pending();await a.complete(request);const cleared=await a.pending();a.close();b.close();
   return {conflict,originalRetained:kept.text===request.text,unrelatedCompletionRetained:notCleared.requestID===request.requestID,matchingCompletionRemoved:cleared===undefined};
  });
  assert.deepEqual(result,{conflict:true,originalRetained:true,unrelatedCompletionRetained:true,matchingCompletionRemoved:true});
  const context=await browser.newContext(),blocked=await context.newPage();await blocked.goto(`http://127.0.0.1:${server.address().port}`);
  const upgrade=await blocked.evaluate(async()=>{
   const original=await new Promise(resolve=>{const r=indexedDB.open('cerney-producer-outbox-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox');r.onsuccess=()=>resolve(r.result);});
   let notice=false;try{await CerneyProducerDrafts.open('f'.repeat(64));}catch(e){notice=e.message.includes('Close other');}
   original.close();
   const next=await new Promise((resolve,reject)=>{const r=indexedDB.open('cerney-producer-outbox-v1',3);r.onsuccess=()=>{r.result.close();resolve(true);};r.onblocked=()=>reject(Error('Orphan connection'));r.onerror=()=>reject(r.error);});
   return {notice,closedLateConnection:next};
  });
  assert.deepEqual(upgrade,{notice:true,closedLateConnection:true});console.log(JSON.stringify({passed:6,browser:'Chromium IndexedDB',productionWrites:false}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});

'use strict';
// Isolated synthetic fixture: real browser/IndexedDB and the actual Producer handler, no live jobs.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const {createProducerDesk,threadSummary,sha}=require('../functions/producer-desk');
const records=new Map(),media=new Map(),calls=[],checks=[],errors=[];
let generation=0,owner='d'.repeat(64),failPart=false,dropSend=false,unauthorized=false;
const web=path.resolve(__dirname,'../tip-alerts'),evidence=process.env.PRODUCER_QA_OUTPUT||'/private/tmp/cerney-producer-qa';
fs.mkdirSync(evidence,{recursive:true});
const read=async key=>structuredClone(records.get(key)||null);
const write=async(key,value,expected)=>{
 if(String(records.get(key)?.generation||0)!==String(expected||0))throw Object.assign(Error('Conflict'),{code:412});
 records.set(key,{data:structuredClone(value),generation:String(++generation)});
};
const handle=createProducerDesk({read,write,list:async()=>({threads:[...records].filter(([k])=>k.startsWith('producer-threads/')).map(([,r])=>threadSummary(r.data)),nextCursor:null}),root:'_tipalerts/v1/',bucket:()=>({
 getFiles:async({prefix})=>[[...media].filter(([n])=>n.startsWith(prefix)).map(([name,bytes])=>({name,metadata:{size:bytes.length}}))],
 file:name=>({save:async bytes=>{if(media.has(name))throw Object.assign(Error('Exists'),{code:412});media.set(name,Buffer.from(bytes));},download:async()=>[media.get(name)]})
})});
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='POST'&&req.url==='/api/tip-alerts'){
   let body='';for await(const part of req)body+=part;const data=JSON.parse(body);calls.push(data);
   if(unauthorized){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{}');}
   if(data.op==='producer-media-part'&&data.index===1&&failPart){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Fixture interrupted upload'}));}
   const result=await handle(data,{id:owner});
   if(data.op==='producer-send'&&dropSend){dropSend=false;res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Fixture lost acknowledgment'}));}
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(result));
  }
  if(req.url==='/setup'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Fixture</title>');}
  const name=new URL(req.url,'http://localhost').pathname.split('/').pop();
  if(!['producer.html','producer.css','producer-client.js','producer-drafts.js'].includes(name)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(web,name)));
 }catch(error){res.writeHead(error.code||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#instruction').disabled);
  const saved=()=>page.waitForFunction(()=>document.querySelector('#saveState').textContent==='Draft saved on this device.');
  const text=()=>page.locator('#instruction').inputValue();
  await page.goto(origin+'/tip-alerts/producer.html');await ready();
  await page.locator('#instruction').fill('Fictional harbor report. Preserve the witness attribution.');await saved();
  await page.locator('#styleBox').evaluate(e=>e.open=true);await page.locator('#title').fill('Harbor test draft');await page.selectOption('#length','short');await page.locator('#captions').uncheck();await saved();
  await page.reload();await ready();assert.match(await text(),/Fictional harbor/);assert.equal(await page.locator('#length').inputValue(),'short');assert.equal(await page.locator('#captions').isChecked(),false);checks.push('unsent context, title and styles survive reload');
  await page.locator('#new').click();await ready();await page.locator('#instruction').fill('Second fictional report, a different case.');await saved();
  await page.getByRole('button',{name:/Harbor test draft/}).click();await ready();assert.match(await text(),/Fictional harbor/);checks.push('switching stories preserves separate drafts');
  await page.locator('#styleBox').evaluate(e=>e.open=false);
  failPart=true;
  const choose=()=>page.locator('#files').evaluate(input=>{const bytes=new Uint8Array(5*1024*1024);bytes.fill(31);const file=new File([bytes],'fixture-interview.mov',{type:'video/quicktime',lastModified:123456});const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await choose();await page.getByText('Fixture interrupted upload',{exact:false}).waitFor();await saved();assert.equal(await page.locator('#send').isDisabled(),true);const originalParts=calls.filter(x=>x.op==='producer-media-part').length;assert(originalParts>=2);checks.push('failed upload cannot be silently excluded from a send');
  await page.reload();await ready();await page.getByText('Choose this same file again to resume its saved upload.').waitFor();assert.equal(await page.locator('#send').isDisabled(),true);await page.screenshot({path:path.join(evidence,'producer-recovered-phone.png'),fullPage:true});
  failPart=false;const before=calls.filter(x=>x.op==='producer-media-part').length;await choose();await page.waitForFunction(()=>document.querySelector('#assets input')&&!document.querySelector('#send').disabled);await saved();
  const uploaded=calls.filter(x=>x.op==='producer-media-part').slice(before);assert.equal(uploaded.length,1);assert.equal(uploaded[0].index,1);checks.push('reselected original reuses the two already verified chunks');
  await page.locator('#assets input').uncheck();await saved();await page.reload();await ready();assert.equal(await page.locator('#assets input').isChecked(),false);await page.locator('#assets input').check();await saved();checks.push('attachment selection survives reopening');
  dropSend=true;const sendCount=calls.filter(x=>x.op==='producer-send').length;await page.evaluate(()=>{document.querySelector('#compose').requestSubmit();document.querySelector('#compose').requestSubmit();});await page.waitForFunction(()=>!document.querySelector('#retry').hidden);const firstSend=calls.filter(x=>x.op==='producer-send').at(-1);assert(firstSend);assert.equal(calls.filter(x=>x.op==='producer-send').length,sendCount+1);checks.push('rapid double submit creates only one request');
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#retry').hidden);assert.equal(await page.locator('#instruction').isDisabled(),true);await page.locator('#retry').click();await ready();await page.waitForFunction(()=>document.querySelector('#instruction').value==='');
  assert.equal(records.get(`producer-threads/${firstSend.id}.json`).data.commands.length,1);assert.equal(calls.filter(x=>x.op==='producer-send').at(-1).requestID,firstSend.requestID);checks.push('lost acknowledgment and reload retry exactly one cloud command');
  await page.reload();await ready();assert.equal(await text(),'');checks.push('acknowledged send cannot resurrect as an unsent draft');
  await page.locator('#instruction').fill('Private follow-up held for the original device.');await saved();
  owner='e'.repeat(64);await page.goto(origin+'/tip-alerts/producer.html');await ready();assert.equal(await text(),'');assert.equal(await page.getByRole('button',{name:/Harbor test draft.*Draft saved/}).count(),0);checks.push('another device scope cannot read the first device drafts');
  owner='d'.repeat(64);await page.goto(origin+'/tip-alerts/producer.html');await ready();assert.match(await text(),/Private follow-up/);
  unauthorized=true;await page.locator('#new').click();await ready();await page.locator('#instruction').fill('Retain this through expired sign-in.');await saved();await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Sign in'));assert.equal(await text(),'');assert.equal(await page.locator('#instruction').isDisabled(),true);checks.push('expired sign-in clears visible context and locks the composer');
  unauthorized=false;await page.reload();await page.waitForFunction(()=>!document.querySelector('#retry').hidden);assert.match(await text(),/Retain this/);await page.locator('#retry').click();await ready();checks.push('saved send recovers after renewed authentication');
  await page.setViewportSize({width:1100,height:850});await page.screenshot({path:path.join(evidence,'producer-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));checks.push('phone layout has no horizontal overflow');
  // Upgrade an actual v1 outbox in a separate browser profile.
  const legacy=await browser.newContext(),lp=await legacy.newPage();lp.on('pageerror',e=>errors.push(e.message));await lp.goto(origin+'/setup');
  const legacyRequest={...firstSend,id:'9'.repeat(64),requestID:'8'.repeat(64),assetIDs:[],text:'Legacy queued message'};
  await lp.evaluate(async({scope,request})=>{await new Promise((resolve,reject)=>{const r=indexedDB.open('cerney-producer-outbox-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox');r.onsuccess=()=>{const db=r.result,t=db.transaction('outbox','readwrite');t.objectStore('outbox').put(request,scope);t.oncomplete=()=>{db.close();resolve();};t.onerror=reject;};});},{scope:sha(owner),request:legacyRequest});
  await lp.goto(origin+'/tip-alerts/producer.html');await lp.waitForFunction(()=>!document.querySelector('#retry').hidden);assert.equal(await lp.locator('#instruction').inputValue(),'Legacy queued message');checks.push('database upgrade retains the original queued request');
  // Unavailable private storage must not silently accept an unsafe send or discard typed work.
  const unavailable=await browser.newContext();await unavailable.addInitScript(()=>{IDBFactory.prototype.open=function(){throw Error('Fixture storage unavailable');};});const up=await unavailable.newPage();up.on('pageerror',e=>errors.push(e.message));await up.goto(origin+'/tip-alerts/producer.html');await up.waitForFunction(()=>!document.querySelector('#instruction').disabled);await up.locator('#instruction').fill('This must remain visible.');await up.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('Not saved'));await up.locator('#new').click();assert.equal(await up.locator('#instruction').inputValue(),'This must remain visible.');const sends=calls.filter(x=>x.op==='producer-send').length;await up.locator('#send').click();await up.getByText(/Couldn’t save a retry copy/).waitFor();assert.equal(calls.filter(x=>x.op==='producer-send').length,sends);checks.push('storage failure preserves text and blocks unsafe send/navigation');
  assert.deepEqual(errors,[]);checks.push('no browser JavaScript errors');
  fs.writeFileSync(path.join(evidence,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,errors,fixture:'Real Chromium and IndexedDB, actual producer-desk handler with isolated synthetic in-memory cloud records; no production jobs'},null,2));console.log(JSON.stringify({passed:checks.length,errors:errors.length}));
 }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e.stack?.split('\n').slice(0,6).join('\n')||e.message);server.close();process.exitCode=1;});

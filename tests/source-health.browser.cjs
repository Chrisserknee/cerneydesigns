'use strict';
// Synthetic data only; no sign-in, source collection, or production mutations.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=process.env.SOURCE_HEALTH_QA_OUTPUT;
if(!output)throw Error('Set SOURCE_HEALTH_QA_OUTPUT outside the public website.');
fs.mkdirSync(output,{recursive:true});
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tip-alerts/style.css"><link rel="stylesheet" href="/tip-alerts/newsroom.css"><main><section class="desk-heading"><h1>Inbox · test data</h1></section></main><script src="/tip-alerts/source-health.js"></script><script src="/tip-alerts/newsroom.js"></script>';
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
 if(!['/tip-alerts/style.css','/tip-alerts/newsroom.css','/tip-alerts/source-health.js','/tip-alerts/newsroom.js'].includes(name)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(root,name)));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});const checks=[];
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async()=>{
   const now=new Date().toISOString();let note;globalThis.qaCalls=[];
   globalThis.qaMonitor={checkedAt:now,sourceHealth:{version:1,collectors:[{id:'facebook-groups',status:'stale',summary:'No recent group-check report. Current group activity is unknown.',lastReceiptAt:'2026-10-20T08:03:20Z'},{id:'official-pages',status:'blocked',summary:'A source check is blocked. A recent attempt does not mean the pages were checked.',lastAttemptAt:now,nextScheduledAt:new Date(Date.now()+3600000).toISOString()}]}};
   globalThis.qaAPI=async(op,p={})=>{qaCalls.push(op);if(op==='newsroom')return {alerts:[{id:'a'.repeat(64),title:'Synthetic source report',summary:'A source claim awaiting verification.',kind:'facebook_group',priority:'routine',observedAt:now,location:'Test location',timeLabel:'Event time unconfirmed',verification:'Source report · needs verification',sources:[]}],notes:[],monitor:qaMonitor};if(op==='field-save'){note=structuredClone(p.note);return {note};}if(op==='field-get')return {note};throw Error('Unexpected operation '+op);};
   await CerneyNewsroom.refresh(qaAPI,true);
  });
  const panel=page.locator('.source-health');assert.equal(await panel.getAttribute('open'),null);
  await panel.locator('summary').click();await page.getByText('App sync',{exact:true}).waitFor();
  assert.equal(await panel.getByText('Connected',{exact:true}).count(),1);assert.equal(await panel.getByText('Check blocked',{exact:true}).count(),1);assert.equal(await panel.getByText('No recent report',{exact:true}).count(),1);
  checks.push('sync, stale group report and blocked agency check are distinct in the actual newsroom UI');
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(output,`source-health-phone-${colorScheme}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1280,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'source-health-desktop.png'),fullPage:true});checks.push('390px light/dark and desktop layouts have no horizontal overflow');
  await page.evaluate(()=>CerneyNewsroom.startStory({title:'Synthetic notebook',evidence:[]}));
  const notes=page.getByLabel('Reporting notes');await notes.fill('Keep these reporting notes while refreshing connection status.');
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  assert.equal(await notes.inputValue(),'Keep these reporting notes while refreshing connection status.');assert.notEqual(await panel.getAttribute('open'),null);
  const calls=await page.evaluate(()=>qaCalls);assert(calls.filter(x=>x==='newsroom').length>=2);assert(calls.every(x=>['newsroom','field-save','field-get'].includes(x)));
  checks.push('refresh preserves expanded status and notebook edits, and never launches a collector');
  await page.evaluate(async()=>{qaMonitor.sourceHealth.collectors.forEach(r=>r.status='paused');await CerneyNewsroom.refresh(qaAPI,true);});
  assert.equal(await panel.locator('summary').innerText(),'Source checks paused');assert(!(await panel.innerText()).includes('Next scheduled slot'));checks.push('intentional pause remains neutral and hides future check promises');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify({passed:true,checks},null,2)+'\n');console.log(JSON.stringify({passed:true,checks}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});

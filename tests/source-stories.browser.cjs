'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{createFieldNotes}=require('../functions/field-notes'),{noteMetadata,noteSummary}=require('../functions/field-note-index');
const output=process.env.SOURCE_STORIES_QA_OUTPUT;if(!output)throw Error('Set SOURCE_STORIES_QA_OUTPUT outside the public website.');fs.mkdirSync(output,{recursive:true});
const records=new Map(),calls=[],root=path.resolve(__dirname,'..');let generation=0,holdGet=false,releaseGet;
const handle=createFieldNotes({read:async name=>structuredClone(records.get(name)||null),write:async(name,data,expected)=>{if((records.get(name)?.generation||0)!==expected)throw Object.assign(Error('Concurrent update'),{code:412});records.set(name,{data:structuredClone(data),generation:++generation});},bucket:()=>{throw Error('No audio storage in this test');},root:'fixture/'});
const id=n=>n.toString(16).padStart(64,'0');
const alert=n=>({id:id(n),title:'Synthetic source '+n,summary:'A reported event awaiting verification.',kind:'facebook_group',priority:'routine',observedAt:new Date().toISOString(),location:'Example Road',timeLabel:'Event time unconfirmed',verification:'Source report · needs verification',whatChanged:'Another account received',questions:['When did it happen?'],contradictions:['Accounts give different locations.'],sources:[{label:'Original source',url:'https://example.com/source/'+n}]});
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tip-alerts/style.css"><link rel="stylesheet" href="/tip-alerts/newsroom.css"><main><section class="desk-heading"><h1>Source stories · test data</h1></section></main><script src="/tip-alerts/source-health.js"></script><script src="/tip-alerts/source-stories.js"></script><script src="/tip-alerts/newsroom.js"></script>';
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html);}
 if(['/tip-alerts/style.css','/tip-alerts/newsroom.css','/tip-alerts/source-health.js','/tip-alerts/source-stories.js','/tip-alerts/newsroom.js'].includes(pathname)){res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(path.join(root,pathname)));}
 if(pathname!=='/qa-api'){res.statusCode=404;return res.end();}
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);
  if(holdGet&&body.op==='field-get'){holdGet=false;await new Promise(resolve=>{releaseGet=resolve;});}
  const result=body.op==='newsroom'?{alerts:[1,2,3].map(alert),notes:[...records.values()].map(x=>noteSummary(noteMetadata(x.data),x.data.id)),monitor:{checkedAt:new Date().toISOString(),collection:{lastReportAt:new Date().toISOString(),coverage:[{status:'complete'}]}}}:await handle(body);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=e.code===412?409:e.code||500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message}));}
});
(async()=>{
 await handle({op:'field-save',id:id(90),note:{id:id(90),revision:1,kind:'notebook',title:'Existing reporting notebook',createdAt:new Date().toISOString(),transcript:'Original transcript',draft:'Draft to preserve',notes:'Reporter notes',evidence:[],relatedIDs:[]},expectedRevision:0});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true}),checks=[];
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async()=>{globalThis.qaAPI=async(op,p={})=>{const r=await fetch('/qa-api',{method:'POST',body:JSON.stringify({op,...p})});const x=await r.json();if(!r.ok)throw Object.assign(Error(x.error),{status:r.status});return x;};await CerneyNewsroom.refresh(qaAPI,true);});
  const card=n=>page.locator('#alert-'+id(n)),openCard=async n=>{if(await card(n).getAttribute('open')===null)await card(n).locator('summary').click();};
  await openCard(1);await card(1).getByRole('button',{name:'Start story',exact:true}).click();await page.getByLabel('Story title').waitFor({state:'visible'});
  await page.getByLabel('Reporting notes',{exact:true}).fill('Keep my local reporting direction.');await card(1).getByRole('button',{name:'Open story',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Reporting notes"]')?.value==='Keep my local reporting direction.'&&document.querySelector('#fieldStatus')?.textContent==='All edits saved.');
  assert.equal(records.size,2);checks.push('opening a source twice reuses one notebook and preserves current edits');
  await openCard(2);await card(2).getByRole('button',{name:'Add to an existing story',exact:true}).click();await card(2).getByLabel('Choose existing story').selectOption(id(90));await card(2).getByRole('button',{name:'Add source',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Story title"]')?.value==='Existing reporting notebook');
  const saved=records.get('field-notes/'+id(90)+'.json').data;assert.equal(saved.draft,'Draft to preserve');assert.equal(saved.transcript,'Original transcript');assert.equal(saved.notes,'Reporter notes');assert.equal(saved.evidence.length,1);assert(saved.evidence[0].excerpt.includes('Accounts give different locations.'));
  await page.evaluate(()=>CerneyNewsroom.refresh(qaAPI,true));await card(2).getByRole('button',{name:'Open story',exact:true}).waitFor();assert.notEqual(await card(2).getAttribute('open'),null);checks.push('add to existing story preserves transcript/draft/notes and keeps the source card expanded');
  for(const colorScheme of ['light','dark']){await page.emulateMedia({colorScheme});await card(2).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`source-stories-phone-${colorScheme}.png`)});}
  checks.push('source actions remain readable at phone width under both system color preferences');
  // A held read from an old sign-in must not create or display a notebook after clear.
  holdGet=true;await openCard(3);await card(3).getByRole('button',{name:'Start story',exact:true}).click();
  for(let attempt=0;attempt<50&&!releaseGet;attempt++)await new Promise(r=>setTimeout(r,20));assert(releaseGet);
  const before=calls.filter(c=>c.op==='field-save').length;await page.evaluate(async()=>{CerneyNewsroom.clear();await CerneyNewsroom.refresh(qaAPI,true);});releaseGet();
  await page.waitForTimeout(150);assert.equal(calls.filter(c=>c.op==='field-save').length,before);assert.equal(await page.getByLabel('Reporting notes',{exact:true}).count(),0);checks.push('late source response after sign-out cannot create or reveal a notebook');
  await page.setViewportSize({width:1280,height:900});await openCard(1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'source-stories-desktop.png'),fullPage:true});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify({passed:true,checks,productionWrites:false},null,2)+'\n');console.log(JSON.stringify({passed:true,checks}));
 }finally{releaseGet?.();await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});

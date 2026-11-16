'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {createHmac}=require('node:crypto');
const {createWatchIngest,MAX_PER_HOUR}=require('./watch-ingest');
const {watchBatch,mergeWatch,watchView,watchEvent}=require('./watch-record');
const KEY='w'.repeat(48),NOW=Date.parse('2026-11-16T21:00:00Z');
const iso=ms=>new Date(ms).toISOString();
const event=(over={})=>({id:'a'.repeat(64),revision:1,sourceId:'nws-alerts',sourceRef:'urn:1',kind:'alert',category:'weather',status:'active',
 title:'Wind Advisory',summary:'Southwest winds 25 to 35 mph.',counties:['Monterey'],sentAt:iso(NOW-3600000),effectiveAt:iso(NOW-3600000),
 expiresAt:iso(NOW+3600000),endsAt:iso(NOW+7200000),fetchedAt:iso(NOW),sourceName:'NWS San Francisco CA',
 sourceURL:'https://api.weather.gov/alerts/urn:1',attribution:'National Weather Service',evidence:'official_alert',...over});
const batch=(seq,upserts=[event()],over={})=>({schema:'cerney-watch/1',seq,batchId:String(seq).padStart(64,'0'),kind:'delta',createdAt:iso(NOW),
 collector:{id:'mac-collector-1',version:'1.0.0',paused:false,startedAt:iso(NOW-60000),outboxPending:0},
 sources:[{id:'nws-alerts',name:'NWS alerts',status:'ready',lastSuccessAt:iso(NOW),freshSeconds:1200,message:'ok',url:'https://alerts.weather.gov/'},
  {id:'cal-fire',name:'CAL FIRE incidents',status:'not_connected',message:'403'}],upserts,...over});
function request(body,{key=KEY,ts=NOW,keyId='mac-collector-1',headers={},raw}={}){
 const rawBody=raw||Buffer.from(JSON.stringify(body));
 const sig=createHmac('sha256',key).update('cerney-watch-v1.'+ts+'.').update(rawBody).digest('hex');
 return {method:'POST',rawBody,body,is:t=>t==='application/json',headers:{'x-watch-key-id':keyId,'x-watch-timestamp':String(ts),'x-watch-signature':sig,...headers}};
}
const response=()=>({headers:{},set(k,v){this.headers[k]=v;return this;},status(c){this.code=c;return this;},json(b){this.body=b;this.code??=200;return this;}});
function storage(){
 const files=new Map();let generation=0;const writes=[];
 return {files,writes,
  read:async name=>files.has(name)?{data:JSON.parse(files.get(name).bytes),generation:files.get(name).generation}:null,
  write:async(name,data,expected)=>{const old=files.get(name);if(expected!==undefined&&expected!==(old?.generation||0))throw Object.assign(Error(),{code:412});
   writes.push(name);files.set(name,{bytes:JSON.stringify(data),generation:++generation});}};
}
const ingestor=(s,now=()=>NOW)=>createWatchIngest({read:s.read,write:s.write,secret:()=>KEY,now});
async function send(ingest,req){const res=response();await ingest(req,res);return res;}

test('ingest rejects unsigned, wrong-key, stale, gateway-signed and device-token requests without touching storage',async()=>{
 const s=storage(),ingest=ingestor(s),body=batch(1);
 const bad=[request(body,{key:'x'.repeat(48)}),request(body,{keyId:'other'}),request(body,{ts:NOW-301000}),
  {...request(body),headers:{}},
  // Website gateway headers signed with a different secret are not valid here.
  {...request(body),headers:{'x-tip-timestamp':String(NOW),'x-tip-signature':createHmac('sha256','g'.repeat(48)).update(NOW+'.').update(Buffer.from(JSON.stringify(body))).digest('hex')}},
  {...request({...body,token:'d'.repeat(43)}),headers:{}}];
 for(const req of bad){const res=await send(ingest,req);assert.equal(res.code,401);}
 const tampered=request(body);tampered.rawBody=Buffer.from(JSON.stringify(batch(1,[event({title:'Changed'})])));
 assert.equal((await send(ingest,tampered)).code,401);
 assert.equal(s.writes.length,0);
});

test('signed batch is applied under watch/ only; replay is a duplicate; older sequence conflicts',async()=>{
 const s=storage(),ingest=ingestor(s);
 const ok=await send(ingest,request(batch(5)));
 assert.equal(ok.code,200);assert.deepEqual([ok.body.accepted,ok.body.duplicate,ok.body.applied],[true,false,1]);
 assert.deepEqual(s.writes,['watch/state.json']);
 const replay=await send(ingest,request(batch(5),{ts:NOW+1000}));
 assert.deepEqual([replay.code,replay.body.duplicate],[200,true]);assert.equal(s.writes.length,1);
 const older=await send(ingest,request(batch(4)));
 assert.deepEqual([older.code,older.body.error,older.body.lastSeq],[409,'sequence',5]);
 assert.equal(s.writes.length,1);
 assert.equal(ok.headers['Cache-Control'],'no-store');
});

test('revisions only move forward and cancellations replace active alerts',async()=>{
 const s=storage(),ingest=ingestor(s);
 await send(ingest,request(batch(1,[event({revision:2,summary:'newer'})])));
 await send(ingest,request(batch(2,[event({revision:1,summary:'stale replay'})])));
 assert.equal(Object.values(JSON.parse(s.files.get('watch/state.json').bytes).events)[0].summary,'newer');
 await send(ingest,request(batch(3,[event({revision:3,status:'cancelled',messageType:'Cancel'})])));
 const view=watchView(JSON.parse(s.files.get('watch/state.json').bytes),NOW);
 assert.deepEqual([view.events.length,view.events[0].status,view.events[0].revision],[1,'cancelled',3]);
});

test('bounded schema atomically rejects unsafe events and strips unknown fields',()=>{
 const rejected=watchBatch(batch(1,[event(),event({id:'b'.repeat(64),sourceURL:'https://evil.example/x'}),event({id:'c'.repeat(64),counties:['Alameda']}),
  event({id:'d'.repeat(64),riskScore:0.9,prediction:'likely',crimeProbability:0.4}),event({id:'e'.repeat(64),sourceId:'facebook'}),
  event({id:'f'.repeat(64),sourceURL:'http://api.weather.gov/x'}),event({id:'1'.repeat(64),sourceURL:'https://weather.gov.evil.test/'})]),NOW);
 assert.equal(rejected.error,'invalid_event');
 const {batch:b}=watchBatch(batch(1,[event({riskScore:0.9,prediction:'likely',crimeProbability:0.4})]),NOW);
 assert.equal(b.upserts.length,1);assert.equal(b.dropped,0);
 const kept=b.upserts[0];
 assert.equal(JSON.stringify(kept).match(/risk|prediction|probability/i),null);
 assert.equal(watchBatch({...batch(1),schema:'other'},NOW).error,'schema');
 assert.equal(watchBatch(batch(1,Array.from({length:201},()=>event())),NOW).error,'size');
 assert.equal(watchBatch({...batch(1),createdAt:iso(NOW+600000)},NOW).error,'createdAt');
 assert.equal(watchEvent(event({title:''})),null);
 assert.equal(watchEvent(event({location:{lat:40.7,lon:-74}})).location,undefined);
});

test('size and rate limits',async()=>{
 const s=storage(),ingest=ingestor(s);
 const big=request(batch(1),{raw:Buffer.alloc(512*1024+1,32)});
 assert.equal((await send(ingest,big)).code,413);
 for(let i=1;i<=MAX_PER_HOUR;i++)assert.equal((await send(ingest,request(batch(i,[])))).code,200);
 const limited=await send(ingest,request(batch(MAX_PER_HOUR+1,[])));
 assert.deepEqual([limited.code,limited.headers['Retry-After']],[429,'600']);
 const later=ingestor(s,()=>NOW+3600001);
 assert.equal((await send(later,request(batch(MAX_PER_HOUR+2,[]),{ts:NOW+3600001}))).code,200);
});

test('thirty-day retention on merge and seven-day read view',()=>{
 const day=86400000;
 const old=event({id:'1'.repeat(64),status:'ended',endsAt:iso(NOW-31*day),expiresAt:iso(NOW-31*day),effectiveAt:iso(NOW-32*day),sentAt:iso(NOW-32*day),updatedAt:iso(NOW-31*day),fetchedAt:iso(NOW-31*day)});
 const week=event({id:'2'.repeat(64),status:'ended',endsAt:iso(NOW-8*day),expiresAt:iso(NOW-8*day),effectiveAt:iso(NOW-9*day),updatedAt:iso(NOW-8*day)});
 const recent=event({id:'3'.repeat(64),status:'expired',endsAt:iso(NOW-2*day),expiresAt:iso(NOW-2*day),updatedAt:iso(NOW-2*day)});
 const forecast=event({id:'4'.repeat(64),kind:'forecast',status:'forecast',evidence:'official_forecast',sourceId:'nws-forecast',sourceURL:'https://forecast.weather.gov/MapClick.php?lat=36.6&lon=-121.6',
  periods:[{name:'Tonight',startAt:iso(NOW),endAt:iso(NOW+12*3600000),shortForecast:'Showers And Thunderstorms Likely',detailedForecast:'x',temperature:50,temperatureUnit:'F'}],
  signals:[{type:'thunderstorm',startAt:iso(NOW),endAt:iso(NOW+12*3600000),periods:['Tonight'],quote:'Showers And Thunderstorms Likely'},{type:'gang_activity'}]});
 const state={version:1,lastSeq:1,events:Object.fromEntries([old,week,recent].map(e=>[e.id,{...e,receivedAt:e.updatedAt}])),applied:[]};
 const {batch:b}=watchBatch(batch(2,[forecast]),NOW);
 const merged=mergeWatch(state,b,NOW);
 assert.deepEqual(Object.keys(merged.state.events).sort(),['2'.repeat(64),'3'.repeat(64),'4'.repeat(64)]);
 const view=watchView(merged.state,NOW);
 assert.deepEqual(view.events.map(e=>e.id),['4'.repeat(64),'3'.repeat(64)]);
 assert.deepEqual(view.events[0].signals.map(s=>s.type),['thunderstorm']);
 assert.equal(view.sources.find(x=>x.id==='cal-fire').status,'not_connected');
 assert.equal(view.collector.lastSeq,2);
 assert.deepEqual(watchView(null,NOW).events,[]);
});

// tipAlertsApi harness (same shape as tip-alerts.test.js) for the device reader.
function harness(initial={}){
 const files=new Map(Object.entries(initial).map(([name,data])=>[name,{data,generation:1}]));const saves=[];
 const b={file(name,opts={}){return {name,getMetadata:async()=>{const x=files.get(name);if(!x)throw Object.assign(Error(),{code:404});return [{generation:x.generation}];},
  download:async()=>{const x=files.get(name);if(!x)throw Object.assign(Error(),{code:404});return [Buffer.from(JSON.stringify(x.data))];},
  save:async(value)=>{saves.push(name);files.set(name,{data:JSON.parse(value),generation:2});}};},getFiles:async({prefix})=>[[...files.keys()].filter(n=>n.startsWith(prefix)).map(name=>({name,metadata:{generation:1}}))]};
 const c=vm.createContext({exports:{},Buffer,URL,Date,Intl,AbortSignal,fetch:async()=>({ok:false}),require(name){
  if(name==='firebase-functions/params')return {defineSecret:()=>({value:()=> 'test-secret'.repeat(4)})};
  if(name==='web-push')return {sendNotification:async()=>{},generateVAPIDKeys:()=>({publicKey:'p',privateKey:'q'})};
  if(name==='firebase-admin/storage')return {getStorage:()=>({bucket:()=>b})};
  if(name==='firebase-functions')return {logger:{info(){},warn(){},error(){}}};
  if(name==='firebase-functions/v2/storage')return {onObjectFinalized:(_,f)=>f,onObjectMetadataUpdated:(_,f)=>f};
  if(name==='firebase-functions/v2/scheduler')return {onSchedule:(_,f)=>f};
  if(name==='firebase-functions/v2/https')return {onRequest:(_,f)=>f};
  return require(name);
 }});
 vm.runInContext(fs.readFileSync(__dirname+'/tip-alerts.js','utf8')+'\nthis.testing={handleApi};',c);
 return {handleApi:c.testing.handleApi,capture:c.exports.captureWebTip,saves};
}

test('device reader needs an active paired device; tip API cannot write Watch',async()=>{
 const h=require('./tip-alerts-helpers'),token='s'.repeat(43),id=h.hash(token);
 const state=mergeWatch(null,watchBatch(batch(1),NOW).batch,Date.now()).state;
 const x=harness({['_tipalerts/v1/devices/'+id+'.json']:{id,createdAt:iso(NOW),sessionPolicy:'until-sign-out',expiresAt:null,subscription:null},
  ['_tipalerts/v1/devices/'+'r'.repeat(64)+'.json']:{id:'r'.repeat(64),createdAt:iso(NOW),revokedAt:iso(NOW),expiresAt:iso(NOW-1000)},
  '_tipalerts/v1/watch/state.json':state});
 const res=()=>({set(){},status(c){this.code=c;return this;},json(b){this.body=b;return this;}});
 const denied=res();await x.handleApi({method:'POST',is:()=>true,body:{op:'watch',token:'invalid'}},denied);assert.equal(denied.code,401);
 const allowed=res();await x.handleApi({method:'POST',is:()=>true,body:{op:'watch',token}},allowed);
 assert.equal(allowed.body.version,1);assert.equal(allowed.body.events.length,1);assert.equal(allowed.body.events[0].title,'Wind Advisory');
 const write=res();await x.handleApi({method:'POST',is:()=>true,body:{op:'watch-ingest',token,upserts:[event()]}},write);assert.equal(write.code,400);
 assert.equal(x.saves.length,0);
});

test('Watch writes never trigger tip, incident, research, story-request or video pipelines',async()=>{
 const x=harness();
 const name='_tipalerts/v1/watch/state.json',object={bucket:'tip-line-8c2d7.firebasestorage.app',name,generation:'7',contentType:'application/json',size:'100'};
 await x.capture({data:object});assert.equal(x.saves.length,0);
 assert.equal(require('./news-video-processing').eventTarget(object),null);
 for(const file of ['incident-alerts.js','research-alerts.js','story-request-alerts.js']){
  let reads=0;const alerts=require('./'+file).createAlerts({read:async()=>{reads++;return null;},write:async()=>{throw Error('no write');},documents:async()=>{reads++;return [];},send:async()=>{throw Error('no send');},config:async()=>({})});
  await alerts.capture({data:object});assert.equal(reads,0,file);
 }
 const index=fs.readFileSync(__dirname+'/index.js','utf8');assert.match(index,/if \(!filePath \|\| !filePath\.startsWith\('tips\/'\)\)/);
 // The ingest function holds only its own secret; tipAlertsApi never receives it.
 const tip=fs.readFileSync(__dirname+'/tip-alerts.js','utf8'),wf=fs.readFileSync(__dirname+'/watch-functions.js','utf8');
 assert.doesNotMatch(tip,/WATCH_INGEST_KEY/);assert.match(wf,/secrets:\[ingestKey\]/);
 assert.doesNotMatch(wf+fs.readFileSync(__dirname+'/watch-ingest.js','utf8')+fs.readFileSync(__dirname+'/watch-record.js','utf8'),/openai|anthropic|claude|codex|gpt-|llm/i);
});

 test('a mixed invalid batch performs no storage write and leaves sequence retryable',async()=>{
 const s=storage(),ingest=ingestor(s);
 const bad=await send(ingest,request(batch(1,[event(),event({id:'bad'})])));
 assert.equal(bad.code,400);assert.equal(bad.body.error,'invalid_event');assert.equal(s.writes.length,0);
 const good=await send(ingest,request(batch(1,[event()])));
 assert.equal(good.code,200);assert.equal(good.body.applied,1);
});

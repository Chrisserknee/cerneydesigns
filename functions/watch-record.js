'use strict';
// Cerney Tips Watch records. Official-source alerts, forecasts, CHP logs and
// Caltrans closures sent by the Mac collector. Deterministic validation only:
// unknown fields are dropped, so scores or predictions can never be stored.
const SOURCES=['nws-alerts','nws-forecast','chp-incidents','caltrans-closures'];
const KINDS=['alert','forecast','incident','closure'];
const CATEGORIES=['weather','flood','fire','tsunami','air','coastal','traffic','road'];
const STATUSES=['active','upcoming','expired','ended','cancelled','inactive','forecast'];
const EVIDENCE=['official_alert','official_forecast','official_dispatch_log','official_closure'];
const COUNTIES=['Monterey','Santa Cruz','San Benito'];
const SOURCE_STATUSES=['ready','partial','backoff','capped','paused','unknown','not_connected'];
const HOSTS=['weather.gov','chp.ca.gov','dot.ca.gov'];
const LIMITS={events:1500,view:400,upserts:200,sources:32,applied:200,retentionDays:30,viewDays:7};
const text=(x,n)=>typeof x==='string'?x.replace(/\r\n/g,'\n').trim().slice(0,n):'';
const line=(x,n)=>typeof x==='string'?x.replace(/\s+/g,' ').trim().slice(0,n):'';
const date=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
const int=(x,lo,hi)=>Number.isInteger(x)&&x>=lo&&x<=hi?x:null;
function link(value){
 try{
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||value.length>500)return null;
  return HOSTS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;
 }catch{return null;}
}
function strings(value,max,n){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const out={};
 for(const [k,v] of Object.entries(value).slice(0,max))if(/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)&&typeof v==='string'&&v)out[k]=line(v,n);
 return Object.keys(out).length?out:undefined;
}
function period(p){
 const startAt=date(p?.startAt),endAt=date(p?.endAt),name=line(p?.name,40);
 if(!startAt||!endAt||!name)return null;
 const n=x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<1000?Math.round(x):null;
 return {name,startAt,endAt,isDaytime:p.isDaytime===true,temperature:n(p.temperature),temperatureUnit:['F','C'].includes(p.temperatureUnit)?p.temperatureUnit:null,
  windSpeed:line(p.windSpeed,40),windDirection:line(p.windDirection,8),shortForecast:line(p.shortForecast,120),detailedForecast:line(p.detailedForecast,600),
  precipChance:n(p.precipChance)};
}
function signal(s){
 if(!['thunderstorm','heavy_rain','snow','hail','dense_fog','strong_wind'].includes(s?.type))return null;
 return {type:s.type,startAt:date(s.startAt),endAt:date(s.endAt),periods:(Array.isArray(s.periods)?s.periods:[]).slice(0,14).map(x=>line(x,40)).filter(Boolean),quote:line(s.quote,200)};
}
function watchEvent(x){
 if(!x||typeof x!=='object'||!/^[a-f0-9]{64}$/.test(x.id||''))return null;
 const revision=int(x.revision,1,1e6),title=line(x.title,180);
 const counties=Array.isArray(x.counties)?COUNTIES.filter(c=>x.counties.includes(c)):[];
 if(!revision||!title||!counties.length||!SOURCES.includes(x.sourceId)||!KINDS.includes(x.kind)||!CATEGORIES.includes(x.category)
  ||!STATUSES.includes(x.status)||!EVIDENCE.includes(x.evidence))return null;
 const sourceURL=link(x.sourceURL);
 if(!sourceURL)return null;
 const loc=x.location&&typeof x.location==='object'?x.location:null;
 const location=loc&&typeof loc.lat==='number'&&typeof loc.lon==='number'&&loc.lat>35.4&&loc.lat<37.6&&loc.lon>-122.7&&loc.lon<-120.1?{lat:Math.round(loc.lat*1e5)/1e5,lon:Math.round(loc.lon*1e5)/1e5}:undefined;
 const event={id:x.id,revision,sourceId:x.sourceId,sourceRef:line(x.sourceRef,200),kind:x.kind,category:x.category,status:x.status,
  statusNote:line(x.statusNote,200)||undefined,title,headline:line(x.headline,300)||undefined,summary:text(x.summary,4000),instruction:text(x.instruction,1500)||undefined,
  severity:['Extreme','Severe','Moderate','Minor','Unknown'].includes(x.severity)?x.severity:undefined,
  urgency:['Immediate','Expected','Future','Past','Unknown'].includes(x.urgency)?x.urgency:undefined,
  certainty:['Observed','Likely','Possible','Unlikely','Unknown'].includes(x.certainty)?x.certainty:undefined,
  counties,areaDesc:line(x.areaDesc,500)||undefined,messageType:['Alert','Update','Cancel'].includes(x.messageType)?x.messageType:undefined,vtec:line(x.vtec,80)||undefined,
  sourceName:line(x.sourceName,120)||'Official source',sourceURL,attribution:line(x.attribution,240),evidence:x.evidence,
  details:strings(x.details,12,100),location,
  periods:Array.isArray(x.periods)?x.periods.slice(0,14).map(period).filter(Boolean):undefined,
  signals:Array.isArray(x.signals)?x.signals.slice(0,84).map(signal).filter(Boolean):undefined};
 for(const k of ['sentAt','effectiveAt','onsetAt','expiresAt','endsAt','clearedAt','fetchedAt','firstSeenAt','updatedAt','generatedAt'])event[k]=date(x[k])||undefined;
 return JSON.parse(JSON.stringify(event));
}
function watchSource(x){
 if(!/^[a-z0-9-]{1,48}$/.test(x?.id||'')||!line(x.name,100))return null;
 const s={id:x.id,name:line(x.name,100),status:SOURCE_STATUSES.includes(x.status)?x.status:'unknown',message:line(x.message,240),
  lastAttemptAt:date(x.lastAttemptAt)||undefined,lastSuccessAt:date(x.lastSuccessAt)||undefined,lastChangeAt:date(x.lastChangeAt)||undefined,nextCheckAt:date(x.nextCheckAt)||undefined,
  consecutiveFailures:int(x.consecutiveFailures,0,1e6)??undefined,lastError:line(x.lastError,40)||undefined,itemsMatched:int(x.itemsMatched,0,1e5)??undefined,
  freshSeconds:int(x.freshSeconds,60,86400)??undefined,url:link(x.url)||undefined};
 return JSON.parse(JSON.stringify(s));
}
// Envelope check is atomic: invalid records reject the entire batch.
function watchBatch(body,now=Date.now()){
 if(!body||typeof body!=='object'||body.schema!=='cerney-watch/1')return {error:'schema'};
 const seq=int(body.seq,1,Number.MAX_SAFE_INTEGER),created=date(body.createdAt);
 if(!seq||!/^[a-f0-9]{64}$/.test(body.batchId||'')||!['delta','heartbeat','resync'].includes(body.kind))return {error:'envelope'};
 if(!created||Date.parse(created)>now+300000||Date.parse(created)<now-7*86400000)return {error:'createdAt'};
 if(!Array.isArray(body.sources)||body.sources.length>LIMITS.sources||!Array.isArray(body.upserts)||body.upserts.length>LIMITS.upserts)return {error:'size'};
 const upserts=body.upserts.map(watchEvent);
 if(upserts.some(x=>!x))return {error:'invalid_event'};
 const c=body.collector||{};
 return {batch:{seq,batchId:body.batchId,kind:body.kind,createdAt:created,
  collector:{id:line(c.id,40),version:line(c.version,20),paused:c.paused===true,startedAt:date(c.startedAt),outboxPending:int(c.outboxPending,0,1e6)??0},
  sources:body.sources.map(watchSource).filter(Boolean),upserts:upserts.filter(Boolean),dropped:upserts.filter(x=>!x).length}};
}
function relevantUntil(e){
 return Math.max(...['endsAt','expiresAt','clearedAt','updatedAt','effectiveAt','receivedAt'].map(k=>Date.parse(e[k]||'')).filter(Number.isFinite),0);
}
const current=e=>['active','upcoming','forecast'].includes(e.status);
// Pure merge: newer revisions replace older ones; equal or older are ignored.
function mergeWatch(state,batch,now=Date.now()){
 const at=new Date(now).toISOString();
 const events={...(state?.events||{})};
 let applied=0;
 for(const e of batch.upserts){
  const old=events[e.id];
  if(old&&old.revision>=e.revision)continue;
  events[e.id]={...e,receivedAt:at};applied++;
 }
 const cutoff=now-LIMITS.retentionDays*86400000;
 let kept=Object.values(events).filter(e=>current(e)||relevantUntil(e)>=cutoff);
 if(kept.length>LIMITS.events)kept=kept.sort((a,b)=>(current(b)-current(a))||(relevantUntil(b)-relevantUntil(a))).slice(0,LIMITS.events);
 return {state:{version:1,lastSeq:batch.seq,receivedAt:at,collector:batch.collector,sources:batch.sources,
  events:Object.fromEntries(kept.map(e=>[e.id,e])),
  applied:[...(state?.applied||[]),{batchId:batch.batchId,seq:batch.seq,at}].slice(-LIMITS.applied),
  rate:state?.rate&&now-state.rate.startedAt<3600000?{startedAt:state.rate.startedAt,count:state.rate.count+1}:{startedAt:now,count:1}},
  applied,pruned:Object.keys(events).length-kept.length};
}
// Read model for the app: seven-day view plus anything still current.
function watchView(state,now=Date.now()){
 if(state?.version!==1)return {version:1,generatedAt:new Date(now).toISOString(),receivedAt:null,collector:null,sources:[],events:[]};
 const cutoff=now-LIMITS.viewDays*86400000;
 const events=Object.values(state.events||{}).map(watchEvent).filter(Boolean).filter(e=>current(e)||relevantUntil(e)>=cutoff)
  .sort((a,b)=>(current(b)-current(a))||(Date.parse(b.updatedAt||b.sentAt||0)-Date.parse(a.updatedAt||a.sentAt||0))).slice(0,LIMITS.view);
 return {version:1,generatedAt:new Date(now).toISOString(),receivedAt:date(state.receivedAt),collector:state.collector?{...state.collector,lastSeq:state.lastSeq}:null,
  sources:(state.sources||[]).map(watchSource).filter(Boolean),events};
}
module.exports={watchEvent,watchSource,watchBatch,mergeWatch,watchView,LIMITS};

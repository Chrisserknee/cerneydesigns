'use strict';
const text=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
function sourceURL(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!['localhost','127.0.0.1','::1'].includes(u.hostname)&&!u.hostname.endsWith('.local')&&!/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)&&![...u.searchParams.keys()].some(k=>/token|secret|password|signature|api.?key/i.test(k))?u.href:null;}catch{return null;}
}
function scannerFeed(value,now=Date.now()){
 const updatedAt=date(value?.updatedAt);
 if(value?.version!==1||!updatedAt||Date.parse(updatedAt)>now+300000)return {version:1,updatedAt:null,sources:[],events:[]};
 const sources=(Array.isArray(value.sources)?value.sources:[]).slice(0,12).flatMap(x=>{
  if(!/^[a-z0-9-]{1,48}$/.test(x?.id||'')||!text(x.name,100))return [];
  return [{id:x.id,name:text(x.name,100),status:['ready','paused','stale','unavailable'].includes(x.status)?x.status:'unavailable',checkedAt:date(x.checkedAt),lastItemAt:date(x.lastItemAt),message:text(x.message,240)}];
 });
 const seen=new Set();
 const events=(Array.isArray(value.events)?value.events:[]).slice(0,240).flatMap(x=>{
  const observed=date(x?.observedAt),expires=date(x?.expiresAt);
  if(!/^[a-f0-9]{64}$/.test(x?.id||'')||seen.has(x.id)||!['radio','official','weather','report'].includes(x.kind)||!observed||Date.parse(observed)>now+300000||!text(x.title,180))return [];
  if(x.kind==='weather'?(!expires||Date.parse(expires)<=now):(Date.parse(observed)<now-86400000))return [];
  seen.add(x.id);
  return [{id:x.id,kind:x.kind,source:text(x.source,100)||'Source',title:text(x.title,180),summary:text(x.summary,5000),location:text(x.location,200)||null,observedAt:observed,reportedAt:date(x.reportedAt),expiresAt:expires,sourceURL:sourceURL(x.sourceURL)}];
 }).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)).slice(0,150);
 return {version:1,updatedAt,sources,events};
}
module.exports={scannerFeed};

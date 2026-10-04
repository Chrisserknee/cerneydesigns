'use strict';
const {createHash}=require('node:crypto');
const MB=1024*1024,HOUR=3600000;
const SESSION=/^(submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}$/;
const TYPES=new Set(['application/pdf','image/avif','image/bmp','image/gif','image/heic','image/heif','image/jpeg','image/png','image/tiff','image/webp','video/3gpp','video/3gpp2','video/mp4','video/mpeg','video/quicktime','video/webm','video/x-m4v','video/x-msvideo']);
function filesForGrant(body){
 if(!SESSION.test(body.session||'')||!Array.isArray(body.files)||body.files.length>10||(!body.files.length&&!body.session.startsWith('submit-story_')))throw Error('INVALID_BATCH');
 const files={};let total=0;
 for(const [i,f]of body.files.entries()){
  if(!f||typeof f.name!=='string'||f.name.length>48||!f.name.startsWith(String(i+1).padStart(2,'0')+'_')||!/^\d{2}_[A-Za-z0-9_.() -]+\.(?:pdf|avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp|3gp|3g2|mp4|mpeg|mpg|mov|webm|m4v|avi)$/i.test(f.name)||!TYPES.has(f.type)||!Number.isSafeInteger(f.size)||f.size<1||f.size>500*MB||files[f.name])throw Error('INVALID_BATCH');
  files[f.name]=f.size;total+=f.size;
 }
 if(total>750*MB)throw Error('INVALID_BATCH');
 return {files,total,digest:createHash('sha256').update(JSON.stringify(body.files)).digest('hex')};
}
// Pure decision function; the caller commits this state with a generation CAS.
function reserve(state,body,now=Date.now()){
 const key=body.clientKey;if(!/^[a-f0-9]{64}$/.test(key||''))throw Error('INVALID_CLIENT');
 state=structuredClone(state||{});
 const meter=state.requests&&state.requests.at>now-60000?state.requests:{at:now,count:0};
 meter.count++;state.requests=meter;if(meter.count>1200)return {state,status:503};
 state.clients=Object.fromEntries(Object.entries(state.clients||{}).filter(([,c])=>c.seen>now-45*24*HOUR));
 state.events=(state.events||[]).filter(e=>e.at>now-24*HOUR);
 if(!state.clients[key]&&Object.keys(state.clients).length>=10000)return {state,status:503};
 const c=state.clients[key]||{hits:[],strikes:[],blockedUntil:0};c.hits=c.hits.filter(t=>t>now-10*60000);c.strikes=c.strikes.filter(t=>t>now-HOUR);c.seen=now;state.clients[key]=c;
 if(c.blockedUntil>now)return {state,status:429,blocked:true};
 c.hits.push(now);
 if(c.hits.length>40){c.blockedUntil=now+HOUR;c.quarantineBefore=now;return {state,status:429,blocked:true};}
 let batch;try{batch=filesForGrant(body);}catch{c.strikes.push(now);if(c.strikes.length>=3){c.blockedUntil=now+HOUR;c.quarantineBefore=now;}return {state,status:400,blocked:c.blockedUntil>now};}
 const old=state.events.find(e=>e.session===body.session);
 if(old){if(old.at<=Number(c.quarantineBefore||0))return {state,status:403};if(old.client!==key||old.digest!==batch.digest)return {state,status:403};return {state,status:200,batch};}
 const own=state.events.filter(e=>e.client===key),recent=own.filter(e=>e.at>now-HOUR);
 if(recent.reduce((n,e)=>n+e.bytes,0)+batch.total>4*1024*MB||own.reduce((n,e)=>n+e.bytes,0)+batch.total>8*1024*MB||recent.length>=20){c.strikes.push(now);if(c.strikes.length>=3){c.blockedUntil=now+HOUR;c.quarantineBefore=now;}return {state,status:429,blocked:c.blockedUntil>now};}
 // Distributed-source circuit breaker, distinct from an individual IP block.
 if(state.events.filter(e=>e.at>now-HOUR).length>=600||state.events.reduce((n,e)=>n+e.bytes,0)+batch.total>30*1024*MB)return {state,status:503};
 state.events.push({session:body.session,client:key,digest:batch.digest,bytes:batch.total,at:now});
 return {state,status:200,batch};
}
module.exports={filesForGrant,reserve,SESSION};

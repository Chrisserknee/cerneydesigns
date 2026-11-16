'use strict';
// Least-privilege writer for Cerney Tips Watch. The Mac collector holds only an
// HMAC key that this endpoint accepts; it cannot read tips, devices or any other
// record, and this handler can only write under watch/. Device tokens and the
// website gateway secret are never accepted here.
const {createHmac,timingSafeEqual}=require('node:crypto');
const {watchBatch,mergeWatch}=require('./watch-record');
const KEY_ID='mac-collector-1';
const MAX_BODY=512*1024;
const MAX_PER_HOUR=120;
const STATE='watch/state.json';
function signed(req,secret,now){
 const h=req.headers||{};
 const ts=String(h['x-watch-timestamp']||''),sig=String(h['x-watch-signature']||''),id=String(h['x-watch-key-id']||'');
 if(typeof secret!=='string'||secret.length<32||id!==KEY_ID||!/^\d{13}$/.test(ts)||Math.abs(now-Number(ts))>300000
  ||!/^[a-f0-9]{64}$/.test(sig)||!Buffer.isBuffer(req.rawBody))return false;
 const expected=createHmac('sha256',secret).update('cerney-watch-v1.'+ts+'.').update(req.rawBody).digest();
 return timingSafeEqual(expected,Buffer.from(sig,'hex'));
}
function createWatchIngest({read,write,secret,now=Date.now,log=()=>{}}){
 const guarded=(name,data,generation)=>{
  if(!name.startsWith('watch/'))throw Object.assign(Error('Watch writer is limited to watch/'),{code:500});
  return write(name,data,generation);
 };
 return async function ingest(req,res){
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({error:'method'});
  if(!Buffer.isBuffer(req.rawBody)||req.rawBody.length>MAX_BODY)return res.status(413).json({error:'size'});
  let key;try{key=secret();}catch{key=null;}
  if(!signed(req,key,now()))return res.status(401).json({error:'unauthorized'});
  if(!req.is?.('application/json'))return res.status(400).json({error:'type'});
  const parsed=watchBatch(req.body,now());
  if(parsed.error)return res.status(400).json({error:parsed.error});
  const batch=parsed.batch;
  for(let attempt=0;attempt<4;attempt++){
   const stored=await read(STATE),state=stored?.data;
   if(state?.applied?.some(a=>a.batchId===batch.batchId))return res.json({accepted:true,duplicate:true,lastSeq:state.lastSeq});
   if(state&&batch.seq<=state.lastSeq)return res.status(409).json({error:'sequence',lastSeq:state.lastSeq});
   if(state?.rate&&now()-state.rate.startedAt<3600000&&state.rate.count>=MAX_PER_HOUR)return res.status(429).set('Retry-After','600').json({error:'rate'});
   const merged=mergeWatch(state,batch,now());
   try{await guarded(STATE,merged.state,stored?.generation||0);}
   catch(e){if(e.code===412&&attempt<3)continue;throw e;}
   log({seq:batch.seq,kind:batch.kind,upserts:batch.upserts.length,applied:merged.applied,dropped:batch.dropped,pruned:merged.pruned});
   return res.json({accepted:true,duplicate:false,lastSeq:batch.seq,applied:merged.applied,dropped:batch.dropped});
  }
  return res.status(503).json({error:'busy'});
 };
}
module.exports={createWatchIngest,signed,KEY_ID,MAX_BODY,MAX_PER_HOUR,STATE};

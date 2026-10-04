'use strict';
const {getStorage}=require('firebase-admin/storage');
const {getAuth}=require('firebase-admin/auth');
const {reserve,SESSION}=require('./upload-policy');
const ROOT='_tipsecurity/';
const bucket=()=>getStorage().bucket('tip-line-8c2d7.firebasestorage.app');
async function read(name){try{const f=bucket().file(ROOT+name),[m]=await f.getMetadata(),[b]=await bucket().file(ROOT+name,{generation:m.generation}).download();return {data:JSON.parse(b),generation:m.generation};}catch(e){if(e.code===404)return null;throw e;}}
async function write(name,data,generation){await bucket().file(ROOT+name).save(JSON.stringify(data),{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:generation}});}
async function authorize(body){
 let result;
 for(let i=0;i<8;i++){
  const old=await read('admission.json');result=reserve(old?.data,body);
  try{await write('admission.json',result.state,old?.generation||0);break;}catch(e){if(e.code!==412||i===7)throw e;}
 }
 if(result.status!==200)return {status:result.status,body:{error:result.status===400?'Please choose a valid set of files.':'Uploads are temporarily unavailable from this connection. Please try again later.'}};
 const name='sessions/'+body.session+'.json',old=await read(name);
 const record={session:body.session,clientKey:body.clientKey,files:result.batch.files,totalBytes:result.batch.total,digest:result.batch.digest,createdAt:old?.data.createdAt||Date.now()};
 if(old&&(old.data.clientKey!==body.clientKey||old.data.digest!==record.digest))return {status:403,body:{error:'Upload session mismatch.'}};
 if(!old){try{await write(name,record,0);}catch(e){if(e.code!==412)throw e;const again=await read(name);if(again?.data.clientKey!==record.clientKey||again?.data.digest!==record.digest)throw Error('SESSION_CONFLICT');}}
 const claims={tipSession:body.session,tipFiles:record.files,tipExpires:Date.now()+2*3600000};
 if(Buffer.byteLength(JSON.stringify(claims))>1000)throw Error('CLAIMS_TOO_LARGE');
 const token=await getAuth().createCustomToken('tip_'+body.session,claims);
 return {status:200,body:{token,expiresAt:claims.tipExpires}};
}
async function allowedSession(session){
 if(!SESSION.test(session))return false;
 const [record,state]=await Promise.all([read('sessions/'+session+'.json'),read('admission.json')]);
 if(!record||!state)return false;
 const client=state.data.clients?.[record.data.clientKey];
 return !(client?.blockedUntil>Date.now())&&!(record.data.createdAt<=Number(client?.quarantineBefore||0));
}
async function permittedObject(object){
 const gate=await read('config.json');
 if(!gate?.data.enforcedAfter||Date.parse(object.timeCreated)<Date.parse(gate.data.enforcedAfter))return true;
 return allowedSession(object.name.split('/')[1]);
}
module.exports={authorize,allowedSession,permittedObject};

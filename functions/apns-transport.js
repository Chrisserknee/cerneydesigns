'use strict';
const crypto=require('node:crypto');
const http2=require('node:http2');
const TOPIC='org.chriscerney.tips';
const validToken=value=>typeof value==='string' && /^[a-f0-9]{32,512}$/i.test(value) && value.length%2===0;

function credentials(raw){
 const value=typeof raw==='string'?JSON.parse(raw):raw;
 if(!value || !/^[A-Z0-9]{10}$/.test(value.keyId||'') || !/^[A-Z0-9]{10}$/.test(value.teamId||'') || typeof value.privateKey!=='string')throw Error('APNs configuration unavailable');
 const key=crypto.createPrivateKey(value.privateKey);
 if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('APNs signing key is invalid');
 return {...value,key};
}
function providerToken(config,now){
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const input=encode({alg:'ES256',kid:config.keyId})+'.'+encode({iss:config.teamId,iat:Math.floor(now/1000)});
 return input+'.'+crypto.sign('sha256',Buffer.from(input),{key:config.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
function createAPNs({getCredentials,connect=http2.connect,now=Date.now}){
 let cached;
 function authorization(){
  const raw=getCredentials();
  if(!cached || cached.raw!==raw || now()-cached.created>45*60000){
   const config=credentials(raw);cached={raw,created:now(),token:providerToken(config,now())};
  }
  return cached.token;
 }
 function ready(){try{authorization();return true;}catch{return false;}}
 async function send(registration,payload,collapseID){
  if(!validToken(registration?.token) || !['production','sandbox'].includes(registration.environment))throw Object.assign(Error('Invalid native registration'),{code:400});
  const bytes=Buffer.from(JSON.stringify(payload));
  if(bytes.length>4096)throw Object.assign(Error('Native alert is too large'),{code:400});
  let jwt;
  try{jwt=authorization();}catch{throw Object.assign(Error('Native alerts are not configured yet.'),{code:503});}
  const origin=registration.environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
  return new Promise((resolve,reject)=>{
   const session=connect(origin);let finished=false;
   const end=(error,result)=>{
    if(finished)return;finished=true;clearTimeout(timer);session.close();
    if(error){session.destroy();reject(error);}else resolve(result);
   };
   const timer=setTimeout(()=>end(Object.assign(Error('Apple push connection timed out'),{statusCode:503})),12000);
   session.on('error',()=>end(Object.assign(Error('Apple push connection failed'),{statusCode:503})));
   let request;
   try{request=session.request({':method':'POST',':path':'/3/device/'+registration.token.toLowerCase(),authorization:'bearer '+jwt,
    'apns-topic':TOPIC,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(now()/1000)+86400),
    'apns-id':crypto.randomUUID(),...(collapseID?{'apns-collapse-id':String(collapseID).slice(0,64)}:{})});}
   catch{return end(Object.assign(Error('Apple push request failed'),{statusCode:503}));}
   let status=0,response='',apnsID;
   request.on('response',headers=>{status=Number(headers[':status']);apnsID=headers['apns-id'];});
   request.on('data',chunk=>{if(response.length<1024)response+=chunk.toString();});
   request.on('error',()=>end(Object.assign(Error('Apple push request failed'),{statusCode:503})));
   request.on('end',()=>{
    if(status===200)return end(null,{acceptedAt:new Date(now()).toISOString(),apnsID});
    let reason='';try{reason=JSON.parse(response).reason||'';}catch{}
    if(!/^[A-Za-z]{1,80}$/.test(reason))reason='ProviderError';
    end(Object.assign(Error('Apple did not accept the notification'),{statusCode:status||503,reason}));
   });
   request.end(bytes);
  });
 }
 return {ready,send};
}
module.exports={TOPIC,validToken,credentials,providerToken,createAPNs};

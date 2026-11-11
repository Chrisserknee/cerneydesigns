'use strict';
// Issues short-lived Mac Transfer tickets to an already authenticated, unrevoked Cerney Tips device.
// The Mac verifies the Ed25519 signature and separately requires that exact device to be approved on the Mac.
const crypto=require('node:crypto');
const AUDIENCE='cerney-mac-transfer',LIFETIME=600;
const URL_RULE=/^https:\/\/[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.ts\.net(:(443|8443|10000))?$/;
function createMacTicket({read,signingKey,clock=()=>Date.now()}){
 return async function issue(device){
  if(!device?.id||device.revokedAt)throw Object.assign(Error('Sign in to connect this device.'),{code:401});
  const status=(await read('mac-transfer/status.json'))?.data;
  const fresh=status&&Date.now()-Date.parse(status.checkedAt)<3*60000;
  const url=status&&URL_RULE.test(status.url||'')?status.url:null;
  const key=signingKey();
  if(!url||!key)return {configured:false,online:false};
  const now=clock(),iat=Math.floor(now/1000);
  const sub=crypto.createHash('sha256').update('mac-transfer:'+device.id).digest('hex');
  const body=Buffer.from(JSON.stringify({v:1,aud:AUDIENCE,sub,scope:'rw',iat,exp:iat+LIFETIME,jti:crypto.randomBytes(12).toString('hex')})).toString('base64url');
  const sig=crypto.sign(null,Buffer.from(body),crypto.createPrivateKey(key)).toString('base64url');
  return {configured:true,online:!!fresh,url,ticket:body+'.'+sig,expiresAt:new Date((iat+LIFETIME)*1000).toISOString(),roots:fresh?status.roots:[]};
 };
}
module.exports={createMacTicket,URL_RULE,LIFETIME};

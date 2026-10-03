'use strict';
const {createHmac}=require('node:crypto');
const BACKEND='https://us-west1-tip-line-8c2d7.cloudfunctions.net/tipAlertsApi';
function secret() {
    const key=process.env.TIP_ALERTS_PROXY_SECRET || '';
    if(key.length<32) throw new Error('Tip gateway is not configured');
    return key;
}
async function callTipBackend(payload) {
    const body=JSON.stringify(payload), timestamp=String(Date.now());
    const signature=createHmac('sha256',secret()).update(timestamp+'.'+body).digest('hex');
    return fetch(BACKEND,{method:'POST',headers:{'Content-Type':'application/json','X-Tip-Timestamp':timestamp,'X-Tip-Signature':signature},body,signal:AbortSignal.timeout(25000),redirect:'error'});
}
async function reserveLoginAttempt(request) {
    // Vercel overwrites this header; never use a client-supplied alternate IP.
    const ip=String(request.headers['x-vercel-forwarded-for'] || request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0,100);
    const clientKey=createHmac('sha256',secret()).update('login-ip:'+ip).digest('hex');
    const response=await callTipBackend({op:'login-attempt',clientKey});
    if(response.status===429)return false;
    if(!response.ok || (await response.json()).allowed!==true)throw new Error('Login protection unavailable');
    return true;
}
module.exports={callTipBackend,reserveLoginAttempt};

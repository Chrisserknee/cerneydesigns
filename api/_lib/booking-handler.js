'use strict';
const {createHmac}=require('node:crypto');
const access=require('./booking-auth');
const {reserveLoginAttempt}=require('./tip-backend');
const {isAuthenticated}=require('./admin-auth');
const {bodyIsTooLarge,parseBody,sendJson}=require('./http');
module.exports=async(req,res)=>{
    if(req.method!=='POST')return sendJson(res,405,{error:'POST required.'});
    const origin='https://cerneyselects.com';
    if(req.headers.origin!==new URL(origin).origin)return sendJson(res,403,{error:'Request origin is not allowed.'});
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return sendJson(res,415,{error:'JSON required.'});
    if(bodyIsTooLarge(req,50000))return sendJson(res,413,{error:'Request is too large.'});
    let body;try{body=parseBody(req);}catch{return sendJson(res,400,{error:'Invalid JSON.'});}
    if(body?.op==='login'){
        try{if(!await reserveLoginAttempt(req))return sendJson(res,429,{error:'Too many attempts. Try again in 15 minutes.'});}catch{return sendJson(res,503,{error:'Sign-in protection is temporarily unavailable.'});}
        if(!access.verify(body.password))return sendJson(res,401,{error:'Incorrect booking password.'});
        res.setHeader('Set-Cookie',access.issue());return sendJson(res,200,{authenticated:true});
    }
    if(body?.op==='logout'){res.setHeader('Set-Cookie',access.clear);return sendJson(res,200,{authenticated:false});}
    if(!access.authenticated(req.headers.cookie))return sendJson(res,401,{error:'Enter the booking password to continue.',code:'BOOKING_LOGIN_REQUIRED'});
    if(!body||!['offer','availability','submit','status','sign','checkout','cancel-renewal','billing-invoice','list','approve','decline','settings','save-settings','draft-settings'].includes(body.op))return sendJson(res,400,{error:'Unknown action.'});
    const adminOperation=['list','approve','decline','settings','save-settings','draft-settings'].includes(body.op);
    if(adminOperation&&!isAuthenticated(req))return sendJson(res,401,{error:'Sign in at /book/manage/ first.'});
    if(!adminOperation&&process.env.BOOKING_ENABLED!=='true')return sendJson(res,503,{error:'Online booking is being set up. Contact cerneymedia@gmail.com.'});
    const secret=process.env.BOOKING_PROXY_SECRET||'';
    if(secret.length<32)return sendJson(res,503,{error:'Sponsorship setup is incomplete.'});
    try{
        const ip=String(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
        const payload=JSON.stringify({...body,clientKey:createHmac('sha256',secret).update(ip).digest('hex'),userAgent:String(req.headers['user-agent']||'').slice(0,500)});
        const timestamp=String(Date.now());
        const response=await fetch('https://us-west1-tip-line-8c2d7.cloudfunctions.net/cerneyBookingApi',{
            method:'POST',headers:{'Content-Type':'application/json','X-Tip-Timestamp':timestamp,
                'X-Tip-Signature':createHmac('sha256',secret).update(timestamp+'.'+payload).digest('hex')},
            body:payload,signal:AbortSignal.timeout(55000),redirect:'error'});
        const result=await response.json();return sendJson(res,response.status,result);
    }catch{return sendJson(res,503,{error:'Unable to reach the sponsorship service. Please try again.'});}
};

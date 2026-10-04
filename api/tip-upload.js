'use strict';
const {createHmac}=require('node:crypto');
const {isIP}=require('node:net');
const {callTipBackend}=require('./_lib/tip-backend');
const {parseBody,sendJson}=require('./_lib/http');
module.exports=async(req,res)=>{
 if(req.method!=='POST')return sendJson(res,405,{error:'Method not allowed.'});
 if(req.headers.origin!=='https://www.chriscerney.org')return sendJson(res,403,{error:'Request origin is not allowed.'});
 if(!String(req.headers['content-type']||'').startsWith('application/json'))return sendJson(res,415,{error:'JSON required.'});
 let body;try{body=parseBody(req);if(Buffer.byteLength(JSON.stringify(body))>8192)throw Error();}catch{return sendJson(res,400,{error:'Invalid request.'});}
 // This is Vercel's overwritten, platform-owned header, never a body field or alternate forwarded header.
 const ip=String(req.headers['x-vercel-forwarded-for']||'').trim();
 const key=process.env.TIP_ALERTS_PROXY_SECRET||'';
 if(!isIP(ip)||key.length<32)return sendJson(res,503,{error:'Upload protection unavailable. Please try again.'});
 const clientKey=createHmac('sha256',key).update('upload-ip:'+ip).digest('hex');
 try{const r=await callTipBackend({op:'upload-authorize',clientKey,session:body.session,files:body.files});return sendJson(res,r.status,await r.json());}
 catch{return sendJson(res,503,{error:'Could not start the upload. Please try again.'});}
};

'use strict';
const crypto=require('node:crypto');
const COOKIE='cs_booking';
const ttl=86400;
function configured(env=process.env){return (env.BOOKING_SESSION_SECRET||'').length>=32 && (env.BOOKING_PASSWORD_HASH||'').startsWith('scrypt:');}
function equal(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function signature(payload,env){return crypto.createHmac('sha256',env.BOOKING_SESSION_SECRET).update('booking:'+payload).digest('base64url');}
function authenticated(cookie,env=process.env,now=Date.now()){
 if(!configured(env))return false;
 const token=String(cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
 const [exp,sig,extra]=token.split('.');return !extra&&/^\d+$/.test(exp||'')&&Number(exp)>now&&Number(exp)<=now+ttl*1000&&equal(sig||'',signature(exp,env));
}
function issue(env=process.env,now=Date.now()){const exp=String(now+ttl*1000);return `${COOKIE}=${exp}.${signature(exp,env)}; Path=/; Max-Age=${ttl}; Secure; HttpOnly; SameSite=Strict`;}
function verify(password,env=process.env){
 if(!configured(env)||typeof password!=='string'||password.length>256)return false;
 try{const [,salt,hash]=env.BOOKING_PASSWORD_HASH.split(':');const expected=Buffer.from(hash,'base64url');if(expected.length!==32)return false;return equal(crypto.scryptSync(password,Buffer.from(salt,'base64url'),32).toString('base64url'),hash);}catch{return false;}
}
module.exports={authenticated,configured,issue,verify,clear:`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`};

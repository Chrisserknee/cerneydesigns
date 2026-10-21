const { createHmac, timingSafeEqual } = require('node:crypto');
const COOKIE = 'spotlight_preview';
const headers = {'Cache-Control':'private, no-store, max-age=0','X-Robots-Tag':'noindex, nofollow, noarchive','Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
function sign(value,secret){return createHmac('sha256',secret).update(value).digest('hex');}
function equal(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function validCookie(cookie,secret,now=Date.now()){
 if(!secret||secret.length<32)return false;
 const token=String(cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
 const [expires,signature]=token.split('.');
 return /^\d+$/.test(expires||'')&&Number(expires)>now&&Number(expires)<=now+86400000&&equal(signature||'',sign(expires,secret));
}
function issueCookie(secret,now=Date.now()){const expires=String(now+86400000);return `${COOKIE}=${expires}.${sign(expires,secret)}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`;}
function page(error='') {return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CerneySelects · Private preview</title></head><body style="margin:0;background:#d4cfc4;color:#263c46;font:16px/1.6 system-ui"><main style="max-width:410px;margin:12vh auto;padding:28px"><p style="font-size:12px;letter-spacing:.13em">MONTEREY COUNTY BUSINESSES</p><h1 style="font-size:38px;line-height:1.1">CerneySelects</h1><p>A first look at something local.</p><p>We’re preparing CerneySelects for launch. Enter the shared password to view the private preview.</p><form method="post"><label for="password">Preview password</label><input id="password" name="password" type="password" required autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border:1px solid #a5a399;border-radius:8px;font:inherit"><p role="alert" style="color:#8a352b">${error}</p><button style="background:#345363;color:white;border:0;border-radius:8px;padding:14px 22px;font:inherit;cursor:pointer">View CerneySelects →</button></form><p style="font-size:13px;margin-top:30px">Private preview · Public applications are not open yet.</p><a style="color:inherit" href="mailto:cerneymedia@gmail.com">Contact CerneySelects</a></main></body></html>`;}
async function gate(request,env=process.env){
 const secret=env.SPOTLIGHT_PREVIEW_SESSION_SECRET,password=env.SPOTLIGHT_PREVIEW_PASSWORD;
 if(!password||!secret||secret.length<32)return new Response('Preview is temporarily unavailable.',{status:503,headers});
 const url=new URL(request.url);
 if(validCookie(request.headers.get('cookie'),secret))return null;
 if(request.method==='POST'){
  if(request.headers.get('origin')!==url.origin)return new Response(page('Please try again from this page.'),{status:403,headers});
  if(Number(request.headers.get('content-length')||0)>4096)return new Response('Request too large',{status:413,headers});
  const body=await request.text();if(body.length>4096)return new Response('Request too large',{status:413,headers});
  const entered=new URLSearchParams(body).get('password')||'';
  if(equal(entered,password))return new Response(null,{status:303,headers:{...headers,Location:url.pathname+url.search,'Set-Cookie':issueCookie(secret)}});
  return new Response(page('That password didn’t match. Please try again.'),{status:401,headers});
 }
 return new Response(page(),{status:401,headers});
}

module.exports = {gate,issueCookie,validCookie};

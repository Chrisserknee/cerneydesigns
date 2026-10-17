const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function proxy(authenticated=false, reply={}, status=200) {
 const calls=[];const c=vm.createContext({module:{exports:{}},Buffer,AbortSignal,fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:status<400,status,json:async()=>reply};},require(name){if(name==='./_lib/tip-backend')return {callTipBackend:async body=>{calls.push({body});return {ok:status<400,status,json:async()=>reply};}};if(name==='./_lib/admin-auth')return {isAuthenticated:()=>authenticated};return require('../api/_lib/http');}});
 vm.runInContext(fs.readFileSync(__dirname+'/../api/tip-alerts.js','utf8'),c);
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.body=data;return this;}};
 return {run:c.module.exports,calls,res};
}
const req=(body,headers={})=>({method:'POST',headers:{origin:'https://www.chriscerney.org','content-type':'application/json',...headers},body});
test('tip proxy rejects cross-origin requests and unpaired readers',async()=>{
 const p=proxy();await p.run(req({op:'list'},{origin:'https://evil.test'}),p.res);assert.equal(p.res.code,403);
 await p.run(req({op:'list'}),p.res);assert.equal(p.res.code,401);assert.equal(p.calls.length,0);
});
test('pairing needs an admin session and keeps device tokens in HttpOnly cookies',async()=>{
 const denied=proxy();await denied.run(req({op:'pair'}),denied.res);assert.equal(denied.res.code,401);
 const p=proxy(true,{token:'x'.repeat(43),expiresAt:'later'});
 await p.run(req({op:'pair'},{cookie:'cc_admin_session=signed.sig','user-agent':'test'}),p.res);
 assert.equal(p.res.code,200);assert.equal(p.res.body.token,undefined);assert.match(p.res.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
 assert.equal(p.calls[0].body.adminCookie,'cc_admin_session=signed.sig');
});
test('the proxy ignores caller-supplied backend tokens and admin cookies',async()=>{
 const p=proxy(false,{tips:[]});await p.run(req({op:'list',token:'attacker',adminCookie:'attacker'},{cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);
 assert.equal(p.calls[0].body.token,'x'.repeat(43));assert.equal(p.calls[0].body.adminCookie,undefined);
});


test('each authenticated request renews the protected device cookie, but failures do not',async()=>{
 const headers={cookie:'cc_tip_device='+'x'.repeat(43)};
 const p=proxy(false,{tips:[]});await p.run(req({op:'list'},headers),p.res);
 assert.match(p.res.headers['Set-Cookie'],/Max-Age=34560000; Path=\/api\/tip-alerts; HttpOnly; Secure; SameSite=Strict/);
 const denied=proxy(false,{error:'Sign in'},401);await denied.run(req({op:'status'},headers),denied.res);
 assert.equal(denied.res.headers['Set-Cookie'],undefined);
 const logout=proxy(false,{authenticated:false});await logout.run(req({op:'logout'},headers),logout.res);
 assert.match(logout.res.headers['Set-Cookie'],/cc_tip_device=; Max-Age=0;/);
});

test('thumbnail requests require the same paired cookie and canonical origin',async()=>{
 const p=proxy();
 await p.run(req({op:'thumbnail',id:'a'.repeat(64)}),p.res);assert.equal(p.res.code,401);
 await p.run(req({op:'thumbnail'},{origin:'https://evil.test',cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);assert.equal(p.res.code,403);
 assert.equal(p.calls.length,0);assert.equal(p.res.headers['Cache-Control'],'no-store');
});

test('thumbnail proxy forwards only current descriptor fields and its protected device token',async()=>{
 const expected={op:'thumbnail',id:'a'.repeat(64),generation:'123456789',sha256:'b'.repeat(64),revision:2,contextVersion:3};
 const p=proxy(false,{thumbnail:{mimeType:'image/jpeg',base64:'synthetic'}});
 await p.run(req({...expected,token:'attacker',adminCookie:'attacker',path:'unrelated/private/file',url:'https://evil.test'},
   {cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);
 assert.equal(p.res.code,200);
 assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0].body)),{...expected,token:'x'.repeat(43)});
 assert.equal(p.res.headers['Cache-Control'],'no-store');
 assert.match(p.res.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
});

test('a revoked thumbnail request does not refresh its cookie or become cacheable',async()=>{
 const p=proxy(false,{error:'Sign in again.'},401);
 await p.run(req({op:'thumbnail'},{cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);
 assert.equal(p.res.code,401);assert.equal(p.res.headers['Set-Cookie'],undefined);assert.equal(p.res.headers['Cache-Control'],'no-store');
});

test('Blob image previews are limited to inbox and signup without relaxing scripts or connections',()=>{
 const config=JSON.parse(fs.readFileSync(__dirname+'/../vercel.json','utf8'));
 const inbox=config.headers.find(rule=>rule.source==='/tip-alerts/(.*)');
 assert.equal(inbox.headers.find(h=>h.key==='Cache-Control').value,'no-store');
 const policy=inbox.headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.match(policy,/img-src 'self' blob:;/);assert.match(policy,/connect-src 'self';/);assert.match(policy,/script-src 'self';/);
 assert(!policy.includes('unsafe-inline'));
 const signup=config.headers.find(rule=>rule.source==='/spotlightsignup/(.*)');
 const signupPolicy=signup.headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.match(signupPolicy,/img-src 'self' data: blob: https:;/);
 assert(!config.headers.filter(rule=>rule!==inbox&&rule!==signup).some(rule=>rule.headers.some(h=>h.value.includes('blob:'))));
 for(const rule of config.headers)for(const header of rule.headers.filter(h=>h.key==='Content-Security-Policy')) {
  for(const directive of header.value.split(';').map(value=>value.trim()).filter(Boolean)) if(directive.includes('blob:')) assert(directive.startsWith('img-src '));
 }
});

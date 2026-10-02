const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function proxy(authenticated=false, reply={}) {
 const calls=[];const c=vm.createContext({module:{exports:{}},Buffer,AbortSignal,fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,status:200,json:async()=>reply};},require(name){if(name==='./_lib/admin-auth')return {isAuthenticated:()=>authenticated};return require('../api/_lib/http');}});
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

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function handler({allowed=true,unavailable=false}={}){
 let verified=0,gated=0;
 const c=vm.createContext({module:{exports:{}},Buffer,require(name){
  if(name==='./_lib/http')return require('../api/_lib/http');
  if(name==='./_lib/tip-backend')return {reserveLoginAttempt:async()=>{gated++;if(unavailable)throw Error();return allowed;}};
  if(name==='./_lib/admin-auth')return {isConfigured:()=>true,loginAllowed:()=>true,verifyPassword:()=>{verified++;return true;},recordLogin(){},setSessionCookie(){}};
 }});
 vm.runInContext(fs.readFileSync(__dirname+'/../api/admin-auth.js','utf8'),c);
 const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 return {run:c.module.exports,res,counts:()=>({verified,gated})};
}
const request=(origin='https://www.chriscerney.org',body={password:'valid test password'})=>({method:'POST',headers:{origin,'content-type':'application/json'},body});
test('password checks cannot bypass the persistent limit or protection outage',async()=>{
 for(const options of [{allowed:false},{unavailable:true}]){
  const h=handler(options);await h.run(request(),h.res);
  assert.equal(h.res.code,options.unavailable?503:429);assert.equal(h.counts().verified,0);
 }
});
test('missing/foreign origins and oversized parsed bodies are rejected before authentication',async()=>{
 for(const req of [request(''),request('https://attacker.example'),request(undefined,{password:'x'.repeat(5000)})]){
  const h=handler();await h.run(req,h.res);assert.ok([403,413].includes(h.res.code));assert.equal(h.counts().gated,0);assert.equal(h.counts().verified,0);
 }
});

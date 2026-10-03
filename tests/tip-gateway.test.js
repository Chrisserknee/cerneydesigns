'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {gatewayAuthenticated}=require('../functions/request-auth');
const {callTipBackend,reserveLoginAttempt}=require('../api/_lib/tip-backend');
test('gateway accepts only fresh, signed, unaltered requests',async()=>{
 const old=global.fetch,key='security-test-key'.repeat(4);process.env.TIP_ALERTS_PROXY_SECRET=key;
 let request;
 global.fetch=async(url,options)=>{assert.equal(url,'https://us-west1-tip-line-8c2d7.cloudfunctions.net/tipAlertsApi');request={headers:Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),v])),rawBody:Buffer.from(options.body)};return {ok:true,json:async()=>({allowed:true})};};
 try {
  await callTipBackend({op:'status',token:'x'.repeat(43)});
  assert.equal(gatewayAuthenticated(request,key),true);
  assert.equal(gatewayAuthenticated({...request,headers:{}},key),false);
  assert.equal(gatewayAuthenticated({...request,rawBody:Buffer.from('{"op":"pair"}')},key),false);
  assert.equal(gatewayAuthenticated(request,'wrong'.repeat(12)),false);
  assert.equal(gatewayAuthenticated(request,key,Date.now()+61000),false);
  assert.equal(gatewayAuthenticated({...request,headers:{...request.headers,'x-tip-signature':'a'}},key),false);
 }finally{global.fetch=old;delete process.env.TIP_ALERTS_PROXY_SECRET;}
});
test('login gate sends only an opaque network key and fails closed',async()=>{
 const old=global.fetch;process.env.TIP_ALERTS_PROXY_SECRET='security-test-key'.repeat(4);
 try{
  global.fetch=async(url,options)=>{const p=JSON.parse(options.body);assert.equal(p.op,'login-attempt');assert.match(p.clientKey,/^[a-f0-9]{64}$/);assert.doesNotMatch(options.body,/192\.0\.2/);return {ok:false,status:429};};
  assert.equal(await reserveLoginAttempt({headers:{'x-vercel-forwarded-for':'192.0.2.1'}}),false);
  global.fetch=async()=>({ok:false,status:503});
  await assert.rejects(reserveLoginAttempt({headers:{}}),/unavailable/);
  delete process.env.TIP_ALERTS_PROXY_SECRET;
  await assert.rejects(reserveLoginAttempt({headers:{}}),/not configured/);
 }finally{global.fetch=old;delete process.env.TIP_ALERTS_PROXY_SECRET;}
});

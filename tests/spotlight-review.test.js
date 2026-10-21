'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../api/_lib/spotlight-handlers/review');
const { callModeration, moderationConfig } = require('../api/_lib/spotlight-moderation');
const siteUrl = 'https://preview.example.com';
const token = 'private-token-for-testing-only-123456789';
function response() { return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function request(body, overrides = {}) { return { method:'POST', headers: { origin:siteUrl, 'content-type':'application/json' }, body, ...overrides }; }
function setup(call = async () => ({ status:'pending', decisionAllowed:true })) { return createHandler({ call, getConfig: () => ({ siteUrl }) }); }
async function invoke(req, call) { const r = response(); await setup(call)(req,r); return r; }

test('GET and link scanners cannot execute review decisions', async () => {
 let called = false;
 const r = await invoke(request({ op:'decide', decision:'approve', confirmed:true, token }, { method:'GET' }), async () => { called=true; });
 assert.equal(r.statusCode,405); assert.equal(called,false);
});
test('review requires same-origin JSON and bounded input before proxy access', async () => {
 for(const req of [request({ op:'review',token },{ headers:{origin:'https://evil.example','content-type':'application/json'}}),request({op:'review',token},{headers:{origin:siteUrl,'content-type':'text/plain'}}),request({op:'review',token,extra:'x'.repeat(5000)})]) {
  let called=false; const r=await invoke(req,async()=>{called=true;}); assert.ok([403,415,413].includes(r.statusCode)); assert.equal(called,false);
 }
});
test('review proxy forwards only allowed payload fields and never reflects credential', async () => {
 const calls=[]; const r=await invoke(request({op:'review',token,subscriptionId:'sub_attacker',reason:'extra'}),async(op,payload)=>{calls.push({op,payload});return{status:'pending'};});
 assert.equal(r.statusCode,200);assert.deepEqual(calls,[{op:'review',payload:{token}}]);assert.ok(!JSON.stringify(r.body).includes(token));assert.equal(r.headers['Cache-Control'],'no-store');
});
test('decision requires explicit confirmation; decline requires a bounded plain-text reason', async () => {
 for(const body of [{op:'decide',token,decision:'approve'},{op:'decide',token,decision:'decline',confirmed:true,reason:''},{op:'decide',token,decision:'decline',confirmed:true,reason:'x'.repeat(501)},{op:'decide',token,decision:'decline',confirmed:true,reason:'<b>unsafe</b>'},{op:'decide',token,decision:'refund',confirmed:true}]) {
  let called=false;const r=await invoke(request(body),async()=>{called=true;});assert.equal(r.statusCode,400);assert.equal(called,false);
 }
 const calls=[];const r=await invoke(request({op:'decide',token,decision:'decline',confirmed:true,reason:'  Outside the local service area.  ',amount:1}),async(op,payload)=>{calls.push({op,payload});return{status:'declining'};});
 assert.equal(r.statusCode,200);assert.deepEqual(calls,[{op:'decide',payload:{token,decision:'decline',reason:'Outside the local service area.',confirmed:true}}]);
});
test('provider failures remain retryable without leaking raw internal errors', async()=>{
 const r=await invoke(request({op:'review',token}),async()=>{throw new Error('secret/internal-stack');});assert.equal(r.statusCode,502);assert.doesNotMatch(JSON.stringify(r.body),/secret\/internal/);
 const conflict=await invoke(request({op:'decide',token,decision:'approve',confirmed:true}),async()=>{throw Object.assign(new Error('Already declined.'),{status:409,code:'DECISION_CONFLICT'});});assert.equal(conflict.statusCode,409);assert.equal(conflict.body.code,'DECISION_CONFLICT');
});
test('gateway request signs the exact timestamp and JSON, refuses redirects, and has a timeout', async()=>{
 const original=global.fetch;let capture;
 const secret='test-proxy-secret-that-is-at-least-32-chars';
 global.fetch=async(url,options)=>{capture={url,options};return{ok:true,json:async()=>({status:'pending'})};};
 try {
  await callModeration('review',{token},{ready:true,url:'https://example.com/gateway',secret});
  const {options}=capture; const timestamp=options.headers['X-Spotlight-Timestamp'];
  assert.equal(options.headers['X-Spotlight-Signature'],crypto.createHmac('sha256',secret).update(`${timestamp}.${options.body}`).digest('hex'));
  assert.equal(options.redirect,'error');assert.ok(options.signal);assert.deepEqual(JSON.parse(options.body),{op:'review',token});
 } finally {global.fetch=original;}
});
test('gateway configuration accepts only the fixed private service and a strong shared secret',()=>{
 const oldUrl=process.env.SPOTLIGHT_MODERATION_URL,oldSecret=process.env.SPOTLIGHT_MODERATION_PROXY_SECRET;
 try{process.env.SPOTLIGHT_MODERATION_URL='https://attacker.example';process.env.SPOTLIGHT_MODERATION_PROXY_SECRET='x'.repeat(40);assert.equal(moderationConfig().ready,false);process.env.SPOTLIGHT_MODERATION_URL='https://us-west1-tip-line-8c2d7.cloudfunctions.net/spotlightModerationApi';assert.equal(moderationConfig().ready,true);process.env.SPOTLIGHT_MODERATION_PROXY_SECRET='short';assert.equal(moderationConfig().ready,false);}finally{if(oldUrl===undefined)delete process.env.SPOTLIGHT_MODERATION_URL;else process.env.SPOTLIGHT_MODERATION_URL=oldUrl;if(oldSecret===undefined)delete process.env.SPOTLIGHT_MODERATION_PROXY_SECRET;else process.env.SPOTLIGHT_MODERATION_PROXY_SECRET=oldSecret;}
});

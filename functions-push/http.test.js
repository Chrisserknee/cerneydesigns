'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
function fixture() {
 let handler,captured;
 const context={require:name=>({
  'firebase-admin/app':{initializeApp(){}},'firebase-admin/storage':{getStorage(){}},
  'firebase-functions/v2/https':{onRequest:(options,fn)=>{handler=fn;return fn;}},
  'firebase-functions/params':{defineSecret:()=>({value:()=> 'test-secret'.repeat(5)})},
  'firebase-functions/v2/scheduler':{onSchedule:(options,fn)=>fn},
  './core':{createPushService:()=>({handle:async(body,auth)=>{captured={body,auth};return {ok:true};}})}
 }[name]||require(name)),exports:{},Buffer,Date};
 vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),context);
 const res={headers:{},set(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(data){this.data=data;return this;},end(){return this;}};
 return {handler,res,read:()=>captured};
}
function request(body,headers={}) {const rawBody=Buffer.from(JSON.stringify(body));return {method:'POST',headers,body,rawBody,ip:'127.0.0.1',get:name=>headers[name.toLowerCase()],is:type=>type==='application/json'};}
test('native bearer is accepted but request JSON cannot forge admin or network identity',async()=>{
 const f=fixture();await f.handler(request({op:'admin-list',admin:true,clientKey:'forged',token:'a'.repeat(64)},{authorization:'Bearer '+'b'.repeat(64)}),f.res);
 assert.equal(f.read().auth.admin,false);assert.equal(f.read().auth.token,'b'.repeat(64));assert.notEqual(f.read().auth.clientKey,'forged');
});
test('only a fresh exact-body signature with comments scope admits admin',async()=>{
 for(const valid of [true,false]) {const f=fixture(),req=request({op:'admin-list',scope:valid?'push-v1':'news-v1'});req.headers['x-tip-timestamp']=String(Date.now());req.headers['x-tip-signature']=crypto.createHmac('sha256','test-secret'.repeat(5)).update(req.headers['x-tip-timestamp']+'.').update(req.rawBody).digest('hex');await f.handler(req,f.res);assert.equal(f.read().auth.admin,valid);}
});
test('foreign browser origins, oversized payloads and wrong methods stop before storage',async()=>{
 for(const modify of [req=>{req.headers.origin='https://evil.example';},req=>{req.rawBody=Buffer.alloc(9000);},req=>{req.method='GET';}]) {const f=fixture(),req=request({op:'list'});modify(req);await f.handler(req,f.res);assert([400,403,405].includes(f.res.code));assert.equal(f.read(),undefined);}
});

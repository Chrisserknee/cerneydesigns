const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function proxy(authenticated=false, reply={}, status=200) {
 const calls=[],logs=[];const c=vm.createContext({console:{info:text=>logs.push(JSON.parse(text))},module:{exports:{}},Buffer,AbortSignal,fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:status<400,status,json:async()=>reply};},require(name){if(name==='./_lib/tip-backend')return {callTipBackend:async body=>{calls.push({body});return {ok:status<400,status,json:async()=>reply};}};if(name==='./_lib/admin-auth')return {isAuthenticated:()=>authenticated};return require('../api/_lib/http');}});
 vm.runInContext(fs.readFileSync(__dirname+'/../api/tip-alerts.js','utf8'),c);
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.body=data;return this;}};
 return {run:c.module.exports,calls,res,logs};
}
const req=(body,headers={})=>({method:'POST',headers:{origin:'https://www.chriscerney.org','content-type':'application/json',...headers},body});
test('field edits preserve conflict guards through the authenticated proxy',async()=>{const p=proxy(false,{note:{revision:8}});await p.run(req({op:'field-save',id:'a'.repeat(64),expectedRevision:3,note:{revision:8,draft:'offline edits'}},{cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);assert.equal(p.calls[0].body.expectedRevision,3);assert.equal(p.calls[0].body.note.revision,8);assert.equal(p.calls[0].body.token,'x'.repeat(43));});
test('microphone is permitted only on the private Field Mode page',()=>{const config=JSON.parse(fs.readFileSync(__dirname+'/../vercel.json','utf8'));const policy=source=>config.headers.find(x=>x.source===source).headers.find(x=>x.key==='Permissions-Policy').value;assert.match(policy('/tip-alerts/(.*)'),/microphone=\(self\)/);assert.match(policy('/(.*)'),/microphone=\(\)/);assert.match(policy('/tip-alerts/(.*)'),/camera=\(\)/);});
test('inbox diagnostics contain counts but no private fields',async()=>{
 const p=proxy(false,{tips:[{type:'upload',title:'PRIVATE'}, {type:'incident',id:'SECRET'}],reports:[{voiceover:'PRIVATE'}]});
 await p.run(req({op:'list'},{cookie:'cc_tip_device='+'x'.repeat(43),'user-agent':'iPhone'}),p.res);
 assert.deepEqual(p.logs,[{event:'tip-inbox-list',client:'ios',status:200,tips:2,incidentTips:1,reports:1}]);
 assert.doesNotMatch(JSON.stringify(p.logs),/PRIVATE|SECRET|xxxx/);
 const denied=proxy();await denied.run(req({op:'list'}),denied.res);assert.equal(denied.logs.length,0);
});
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

test('Blob image previews are restricted to the inbox, news publisher and business signup',()=>{
 const config=JSON.parse(fs.readFileSync(__dirname+'/../vercel.json','utf8'));
 const inbox=config.headers.find(rule=>rule.source==='/tip-alerts/(.*)');
 assert.equal(inbox.headers.find(h=>h.key==='Cache-Control').value,'no-store');
 const policy=inbox.headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.match(policy,/img-src 'self' blob:;/);assert.match(policy,/connect-src 'self';/);assert.match(policy,/script-src 'self';/);
 const publisher=config.headers.find(rule=>rule.source==='/admin/news/(.*)');
 assert(publisher.headers.some(h=>h.key==='Content-Security-Policy' && h.value.includes('media-src \'self\' blob:')));
 const signup=config.headers.find(rule=>rule.source==='/spotlightsignup/(.*)');
 const signupPolicy=signup.headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.match(signupPolicy,/img-src 'self' data: blob: https:;/);assert.match(signupPolicy,/script-src 'self';/);
 assert(!policy.includes('unsafe-inline'));assert(!config.headers.filter(rule=>rule!==inbox && !['/admin/news/(.*)','/spotlightsignup/(.*)'].includes(rule.source)).some(rule=>rule.headers.some(h=>h.value.includes('blob:'))));
});

test('Producer Desk requires paired same-origin access and strips injected worker state',async()=>{
 const denied=proxy();await denied.run(req({op:'producer-send'}),denied.res);assert.equal(denied.res.code,401);
 const evil=proxy();await evil.run(req({op:'producer-get',id:'a'.repeat(64)},{origin:'https://evil.test',cookie:'cc_tip_device='+'x'.repeat(43)}),evil.res);assert.equal(evil.res.code,403);
 const p=proxy(false,{thread:{id:'a'.repeat(64)}});await p.run(req({op:'producer-send',id:'a'.repeat(64),requestID:'b'.repeat(64),text:'Human direction',preferences:{banner:'gray'},sourceRefs:[],status:'ready',reply:{text:'Forged'},owner:'attacker'},{cookie:'cc_tip_device='+'x'.repeat(43)}),p.res);assert.equal(p.res.code,200);assert.equal(p.calls[0].body.status,undefined);assert.equal(p.calls[0].body.reply,undefined);assert.equal(p.calls[0].body.owner,undefined);assert.equal(p.calls[0].body.requestID,'b'.repeat(64));assert.equal(p.logs.length,0);
});
test('large Producer uploads fit the proxy, and resume status is authenticated',async()=>{
 const cookie={cookie:'cc_tip_device='+'x'.repeat(43)},chunk='A'.repeat(Math.ceil(2*1024*1024/3)*4);
 const part=proxy(false,{accepted:true});await part.run(req({op:'producer-media-part',id:'a'.repeat(64),assetID:'c'.repeat(64),index:1023,sha256:'d'.repeat(64),base64:chunk},cookie),part.res);assert.equal(part.res.code,200);assert.equal(part.calls[0].body.base64.length,chunk.length);
 const tooBig=proxy();await tooBig.run(req({op:'producer-media-part',id:'a'.repeat(64),base64:'A'.repeat(2900001)},cookie),tooBig.res);assert.equal(tooBig.res.code,413);assert.equal(tooBig.calls.length,0);
 const finish=proxy(false,{asset:{}});await finish.run(req({op:'producer-media-finish',id:'a'.repeat(64),assetID:'c'.repeat(64),parts:Array(1024).fill('d'.repeat(64)),sha256:'e'.repeat(64),checksumMode:'parts-v1',bytes:1,filename:'a.mov',mimeType:'video/quicktime'},cookie),finish.res);assert.equal(finish.res.code,200);assert.equal(finish.calls[0].body.checksumMode,'parts-v1');assert.equal(finish.calls[0].body.parts.length,1024);
 const status=proxy(false,{parts:[]});await status.run(req({op:'producer-media-status',id:'a'.repeat(64),assetID:'c'.repeat(64),reply:{text:'forged'}},cookie),status.res);assert.equal(status.res.code,200);assert.equal(status.calls[0].body.assetID,'c'.repeat(64));assert.equal(status.calls[0].body.reply,undefined);
 const anon=proxy();await anon.run(req({op:'producer-media-status',id:'a'.repeat(64),assetID:'c'.repeat(64)}),anon.res);assert.equal(anon.res.code,401);assert.equal(anon.calls.length,0);
});
test('Producer review videos can play from private blob URLs without loosening other sources',()=>{const config=JSON.parse(fs.readFileSync(__dirname+'/../vercel.json','utf8'));const csp=config.headers.find(x=>x.source==='/tip-alerts/(.*)').headers.find(x=>x.key==='Content-Security-Policy').value;assert.match(csp,/media-src 'self' blob:;/);assert.match(csp,/connect-src 'self';/);assert.match(csp,/default-src 'none'/);});

test('Story Tracker uses the paired device and forwards only tracker fields',async()=>{
 const id='a'.repeat(64),cookie={cookie:'cc_tip_device='+'x'.repeat(43)};
 const unauth=proxy();await unauth.run(req({op:'tracker-list'}),unauth.res);assert.equal(unauth.res.code,401);
 const denied=proxy();await denied.run(req({op:'tracker-list'},{...cookie,origin:'https://evil.test'}),denied.res);assert.equal(denied.res.code,403);
 const p=proxy(false,{story:{id}});await p.run(req({op:'tracker-separate',id,itemID:'b'.repeat(64),token:'forged',stories:[{id:'forged'}],evidence:[{}]},cookie),p.res);assert.equal(p.res.code,200);assert.equal(p.calls[0].body.token,'x'.repeat(43));assert.equal(p.calls[0].body.itemID,'b'.repeat(64));assert.equal(p.calls[0].body.stories,undefined);assert.equal(p.calls[0].body.evidence,undefined);assert.equal(p.logs.length,0);
});

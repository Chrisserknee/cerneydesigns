const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createMacTicket}=require('./mac-transfer-ticket');
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'),pem=privateKey.export({type:'pkcs8',format:'pem'});
const status=(over={})=>async()=>({data:{checkedAt:new Date().toISOString(),url:'https://cerney-mac.tail1234.ts.net',roots:[{id:'projects',state:'ok'}],...over}});
test('an authenticated device gets a 10-minute Ed25519 ticket bound to that device',async()=>{
 const r=await createMacTicket({read:status(),signingKey:()=>pem})({id:'device-1'});
 assert.equal(r.configured,true);assert.equal(r.online,true);assert.equal(r.url,'https://cerney-mac.tail1234.ts.net');
 const [body,sig]=r.ticket.split('.');assert.ok(crypto.verify(null,Buffer.from(body),publicKey,Buffer.from(sig,'base64url')));
 const p=JSON.parse(Buffer.from(body,'base64url'));assert.equal(p.aud,'cerney-mac-transfer');assert.equal(p.exp-p.iat,600);
 assert.equal(p.sub,crypto.createHash('sha256').update('mac-transfer:device-1').digest('hex'));assert.doesNotMatch(r.ticket,/device-1/);
});
test('no ticket for revoked devices, a missing key, or an unsafe Mac address',async()=>{
 await assert.rejects(createMacTicket({read:status(),signingKey:()=>pem})({id:'d',revokedAt:'2026-01-01'}),{code:401});
 assert.deepEqual(await createMacTicket({read:status(),signingKey:()=>null})({id:'d'}),{configured:false,online:false});
 for(const url of ['http://cerney-mac.tail1234.ts.net','https://evil.example','https://a.b.ts.net.evil.com','https://cerney-mac.tail1234.ts.net/path',null])
  assert.equal((await createMacTicket({read:status({url}),signingKey:()=>pem})({id:'d'})).configured,false,String(url));
});
test('an old heartbeat reports the Mac offline instead of pretending',async()=>{
 const r=await createMacTicket({read:status({checkedAt:new Date(Date.now()-10*60000).toISOString()}),signingKey:()=>pem})({id:'d'});assert.equal(r.online,false);assert.deepEqual(r.roots,[]);
});

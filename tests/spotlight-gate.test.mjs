import test from 'node:test';
import assert from 'node:assert/strict';
import {gate,issueCookie,validCookie} from '../spotlight-gate.cjs';
const env={SPOTLIGHT_PREVIEW_PASSWORD:'123',SPOTLIGHT_PREVIEW_SESSION_SECRET:'a'.repeat(64)};
const url='https://www.chriscerney.org/localspotlight/';
test('anonymous page and data requests are blocked, without caching',async()=>{for(const p of ['', 'preview/businesses.json','preview/assets/brand-000.png']){const r=await gate(new Request(url+p),env);assert.equal(r.status,401);assert.match(r.headers.get('cache-control'),/no-store/);assert.match(await r.text(),/Preview password/);}});
test('correct password establishes secure signed cookie and redirects',async()=>{const r=await gate(new Request(url,{method:'POST',headers:{origin:new URL(url).origin},body:'password=123'}),env);assert.equal(r.status,303);const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.equal(await gate(new Request(url,{headers:{cookie}}),env),null);});
test('rejects wrong password, forgery, expiry and cross-origin login',async()=>{assert.equal((await gate(new Request(url,{method:'POST',headers:{origin:new URL(url).origin},body:'password=wrong'}),env)).status,401);assert.equal((await gate(new Request(url,{method:'POST',headers:{origin:'https://other.example'},body:'password=123'}),env)).status,403);assert.equal(validCookie('spotlight_preview=9999999999999.fake',env.SPOTLIGHT_PREVIEW_SESSION_SECRET),false);assert.equal(validCookie(issueCookie(env.SPOTLIGHT_PREVIEW_SESSION_SECRET,Date.now()-86400001),env.SPOTLIGHT_PREVIEW_SESSION_SECRET),false);});
test('missing configuration fails closed',async()=>assert.equal((await gate(new Request(url),{})).status,503));

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {haloAlpha}=require('../tip-alerts/story-film');
test('halation stays off dark scenes and uniformly bright backgrounds',()=>{
 for(const level of [0,80,255]){const rgba=new Uint8Array(32*32*4).fill(level);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;assert(haloAlpha(rgba,32,32).every(a=>a===0));}
});
test('halation follows highlight edges instead of tinting the whole photo',()=>{
 const w=64,h=64,rgba=new Uint8Array(w*h*4);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
 for(let y=26;y<38;y++)for(let x=26;x<38;x++){const i=(y*w+x)*4;rgba[i]=rgba[i+1]=rgba[i+2]=255;}
 const a=haloAlpha(rgba,w,h);assert.equal(a[0],0);assert.equal(a[32*w+32],0);assert(a[25*w+32]>0);assert(Math.max(...a)<80);assert.deepEqual(a,haloAlpha(rgba,w,h));
});
test('font license and full-resolution monochrome grain are bundled locally',()=>{
 const root=__dirname+'/../tip-alerts/';const png=fs.readFileSync(root+'film/grain-v1.png');assert.equal(png.readUInt32BE(16),1080);assert.equal(png.readUInt32BE(20),1920);assert.equal(png[25],0);
 assert.match(fs.readFileSync(root+'fonts/OFL.txt','utf8'),/SIL OPEN FONT LICENSE/);assert(fs.statSync(root+'fonts/BarlowSemiCondensed-Bold.ttf').size>10000);
 const html=fs.readFileSync(root+'index.html','utf8');assert(html.indexOf('story-film.js')<html.indexOf('story-requests.js'));
 const config=JSON.parse(fs.readFileSync(__dirname+'/../vercel.json','utf8')),headers=config.headers.find(h=>h.source==='/tip-alerts/(.*)').headers;
 const policy=headers.find(h=>h.key==='Content-Security-Policy').value;
 assert.equal(policy.split(';').map(x=>x.trim()).find(x=>x.startsWith('font-src ')),"font-src 'self'");
 assert.equal(headers.find(h=>h.key==='Cache-Control').value,'no-store');
 for(const folder of ['fonts','film'])assert.equal(config.headers.find(h=>h.source===`/tip-alerts/${folder}/(.*)`).headers.find(h=>h.key==='Cache-Control').value,'public, max-age=31536000, immutable');
});

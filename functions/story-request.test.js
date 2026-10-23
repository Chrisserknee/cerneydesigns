'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {storyRequest}=require('./story-request-record'),{createAlerts,BUCKET,ROOT,payload}=require('./story-request-alerts');
const iso=n=>new Date(Date.now()+n).toISOString();
function fixture(){return {version:1,id:'a'.repeat(64),state:'draft',revision:1,createdAt:iso(-1000),updatedAt:iso(-1000),expiresAt:iso(3600000),headline:'Were you near Highway 68?',question:'Did you see what happened near Monterey?',context:'I’m looking for people who were there.',location:'Highway 68, Monterey',timeLabel:'October 22',basis:'reported',sources:[{label:'Community tip',kind:'community_tip',tipId:'c'.repeat(64)}],notify:true,reviewNote:'Unverified community report.'};}
function harness(options={}){
 const s=fixture(),device={id:'b'.repeat(64),subscribedAt:iso(-60000),expiresAt:null,sessionPolicy:'until-sign-out',subscription:{endpoint:'https://web.push.apple.com/test'}},keys={enabledAt:iso(-60000)};
 const files=new Map([[`story-requests/${s.id}.json`,{data:s,generation:1}],[`devices/${device.id}.json`,{data:device,generation:1}]]);let count=1,sends=0;
 const read=async n=>files.get(n)||null;
 const write=async(n,data,g)=>{if((files.get(n)?.generation||0)!==g)throw Object.assign(Error(),{code:412});files.set(n,{data,generation:++count});};
 const alerts=createAlerts({read,write,documents:async prefix=>[...files.entries()].filter(([n])=>n.startsWith(prefix)).map(([,v])=>v.data),config:async()=>keys,send:async()=>{sends++;if(options.fail)throw Object.assign(Error(),{statusCode:options.fail});}});
 return {s,device,keys,files,alerts,sends:()=>sends};
}
test('story records are bounded, private and expired drafts do not return',()=>{
 const f=fixture();assert(storyRequest(f));assert.equal(storyRequest({...f,expiresAt:iso(-1)}),null);assert.equal(storyRequest({...f,headline:'x'.repeat(101)}),null);assert.equal(storyRequest({...f,state:'published'}),null);
 assert.equal(storyRequest({...f,basis:'demo'}).notify,false);
 const r=storyRequest({...f,secret:'do-not-return',sources:[{label:'Community tip',contact:'private'}]});assert.doesNotMatch(JSON.stringify(r),/secret|contact|do-not-return/);
});
test('push is generic and opens the specific private draft',()=>{const p=payload(fixture());assert.match(p.notification.navigate,/\?story=[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(p),/Highway|Monterey|Unverified/);});
test('racing events and wording revisions send one alert per incident/device',async()=>{
 const h=harness();await Promise.all([h.alerts.deliver(storyRequest(h.s),h.device,h.keys),h.alerts.deliver(storyRequest(h.s),h.device,h.keys)]);
 h.files.get(`story-requests/${h.s.id}.json`).data.revision=2;await h.alerts.deliver(storyRequest({...h.s,revision:2}),h.device,h.keys);assert.equal(h.sends(),1);
});
test('revocation, demos, stale generations and wrong storage paths never send',async()=>{
 const h=harness();h.files.get(`devices/${h.device.id}.json`).data={...h.device,revokedAt:iso(0)};await h.alerts.deliver(storyRequest(h.s),h.device,h.keys);assert.equal(h.sends(),0);
 const a=harness();await a.alerts.deliver(storyRequest({...a.s,basis:'demo'}),a.device,a.keys);
 await a.alerts.capture({data:{bucket:BUCKET,name:ROOT+`story-requests/${a.s.id}.json`,generation:99}});
 await a.alerts.capture({data:{bucket:'wrong',name:ROOT+`story-requests/${a.s.id}.json`,generation:1}});assert.equal(a.sends(),0);
});
test('failed delivery is retained with backoff and expired subscriptions removed',async()=>{
 const h=harness({fail:503});await h.alerts.deliver(storyRequest(h.s),h.device,h.keys);await h.alerts.deliver(storyRequest(h.s),h.device,h.keys);assert.equal(h.sends(),1);assert([...h.files.values()].some(x=>x.data.status==='pending'));
 const e=harness({fail:410});await e.alerts.deliver(storyRequest(e.s),e.device,e.keys);assert.equal(e.files.get(`devices/${e.device.id}.json`).data.subscription,null);
});

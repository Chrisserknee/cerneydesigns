'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const origin='https://www.chriscerney.org',inbox=origin+'/tip-alerts/',url=inbox+'?tip='+'a'.repeat(64);
function worker(windows=[]) {
 const events={},calls=[];
 const clients={claim:async()=>calls.push(['claim']),matchAll:async()=>windows,openWindow:async target=>{calls.push(['openWindow',target]);return {postMessage:message=>calls.push(['openedMessage',message])};}};
 const context=vm.createContext({URL,self:{location:{origin},clients,skipWaiting:async()=>{},registration:{showNotification:async(title,options)=>calls.push(['showNotification',title,options])},addEventListener:(name,fn)=>{events[name]=fn;}}});
 vm.runInContext(fs.readFileSync(__dirname+'/../tip-alerts/sw.js','utf8'),context);
 const trigger=async(name,extra={})=>{let work;events[name]({notification:{data:{url},close:()=>calls.push(['close'])},waitUntil:p=>{work=p;},...extra});await work;};
 return {calls,trigger};
}
test('notification tap navigates the running inbox before focusing it',async()=>{
 const actions=[],client={url:inbox,navigate:async target=>{actions.push(['navigate',target]);return client;},postMessage:message=>actions.push(['message',message]),focus:async()=>actions.push(['focus'])};
 const h=worker([client]);await h.trigger('notificationclick');
 assert.deepEqual(actions.map(a=>a[0]),['navigate','message','focus']);assert.equal(actions[0][1],url);assert.equal(actions[1][1].url,url);assert(!h.calls.some(c=>c[0]==='openWindow'));
});
test('a closed inbox opens directly to the notification report',async()=>{
 const h=worker([]);await h.trigger('notificationclick');assert.equal(h.calls.find(c=>c[0]==='openWindow')[1],url);
});
test('a failed navigation can still route the existing client by message',async()=>{
 const actions=[],h=worker([{url:inbox,navigate:async()=>{throw Error('unavailable');},postMessage:m=>actions.push(m.url),focus:async()=>actions.push('focus')}]);await h.trigger('notificationclick');assert.deepEqual(actions,[url,'focus']);
});
test('activation refreshes only private inbox clients and preserves selection',async()=>{
 const visited=[],h=worker([{url,navigate:async u=>visited.push(u)},{url:origin+'/admin/',navigate:async u=>visited.push(u)},{url:'https://evil.test/tip-alerts/',navigate:async u=>visited.push(u)}]);
 await h.trigger('activate');assert.deepEqual(visited,[url]);assert.equal(h.calls[0][0],'claim');
});
test('notification destinations cannot leave the private inbox',async()=>{
 for(const target of ['https://evil.test/tip-alerts/','javascript:alert(1)',origin+'/admin/']) {
  const h=worker();await h.trigger('notificationclick',{notification:{data:{url:target},close(){}}});assert.equal(h.calls.find(c=>c[0]==='openWindow')[1],inbox);
 }
});

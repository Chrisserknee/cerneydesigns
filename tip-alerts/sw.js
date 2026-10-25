'use strict';
const RELEASE='2026-10-25-native-handoff-19';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
function inboxURL(value) {
    try {
        const url=new URL(value,self.location.origin+'/tip-alerts/');
        if(url.origin===self.location.origin && url.pathname==='/tip-alerts/')return url.href;
    } catch {}
    return self.location.origin+'/tip-alerts/';
}
self.addEventListener('activate',event=>event.waitUntil((async()=>{
    await self.clients.claim();
    // Never reload a recording or unsaved notebook when a release arrives.
    const windows=await self.clients.matchAll({type:'window'});
    for(const client of windows.filter(client=>inboxURL(client.url)===client.url))
        client.postMessage({type:'cerney-client-update',release:RELEASE});
})()));
// Deliberately no fetch cache: private tip data must never be cached offline.
self.addEventListener('push',event=>{
    let payload={};try{payload=event.data?.json() || {};}catch{}
    const n=payload.notification || {};
    const target=inboxURL(n.navigate || n.data?.url);
    event.waitUntil(self.registration.showNotification(n.title || 'New tip received',{
        body:n.body || 'Open your private tip inbox to review it.',icon:'/tip-alerts/icon-192.png',tag:n.tag || 'tip-alert',data:{url:target},
    }));
});
self.addEventListener('notificationclick',event=>{
    event.notification.close();
    const url=inboxURL(event.notification.data?.url);
    event.waitUntil((async()=>{
        const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
        const existing=windows.find(client=>inboxURL(client.url)===client.url);
        if(existing) {
            // Route within the running app so a notification cannot erase a take.
            existing.postMessage({type:'cerney-tip-open',url});
            try { await existing.focus(); return; } catch {}
        }
        const opened=await self.clients.openWindow(url);
        opened?.postMessage({type:'cerney-tip-open',url});
    })());
});

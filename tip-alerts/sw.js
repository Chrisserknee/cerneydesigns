'use strict';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Deliberately no fetch cache: private tip data must never be cached offline.
self.addEventListener('push',event=>{
    let payload={};try{payload=event.data?.json() || {};}catch{}
    const n=payload.notification || {};
    const fallback=self.location.origin+'/tip-alerts/';
    let target=fallback;
    try{const u=new URL(n.navigate || n.data?.url,fallback);if(u.origin===self.location.origin && u.pathname.startsWith('/tip-alerts/'))target=u.href;}catch{}
    event.waitUntil(self.registration.showNotification(n.title || 'New tip received',{
        body:n.body || 'Open your private tip inbox to review it.',icon:'/tip-alerts/icon-192.png',tag:n.tag || 'tip-alert',data:{url:target},
    }));
});
self.addEventListener('notificationclick',event=>{
    event.notification.close();
    const url=event.notification.data?.url || self.location.origin+'/tip-alerts/';
    event.waitUntil(self.clients.openWindow(url));
});

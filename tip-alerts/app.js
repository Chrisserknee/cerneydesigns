'use strict';
const $ = id => document.getElementById(id);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let state, registration, retryTimer, inboxTimer, inboxRequest, loadRequest, sessionVersion = 0, openAttempts = 0;
const tipId = new URLSearchParams(location.search).get('tip');
const show = (id, visible) => { $(id).hidden = !visible; };
function message(text='', error=false) { $('message').textContent=text; $('message').classList.toggle('error',error); }
function clearSession() {
    state = null; sessionVersion++; message();
    $('inboxStatus').textContent = '';
    clearTimeout(retryTimer); clearTimeout(inboxTimer);
    for (const id of ['tips','devices','selected']) $(id).replaceChildren();
    show('selected',false); show('connected',false); show('login',true); show('intro',true);
}
async function api(op, data={}) {
    const response = await fetch('/api/tip-alerts',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({op,...data})});
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) clearSession(); const error = new Error(result.error || 'Something went wrong. Please try again.'); error.status=response.status; throw error; }
    return result;
}
function bytes(base64) { return Uint8Array.from(atob(base64.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)); }
function manager() { return registration?.pushManager; }
async function prepareNotifications() {
    if (!('serviceWorker' in navigator)) return;
    let timer;
    try {
        registration = await Promise.race([
            navigator.serviceWorker.register('/tip-alerts/sw.js',{scope:'/tip-alerts/'}).then(()=>navigator.serviceWorker.ready),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notification setup timed out.')),8000);}),
        ]);
    } finally { clearTimeout(timer); }
}
async function updateControls() {
    const supported = !!manager() && !!state?.publicKey && 'Notification' in window;
    const local = supported ? await manager().getSubscription() : null;
    const enabled = !!local && state.subscribed && Notification.permission === 'granted';
    $('statusDot').classList.toggle('enabled',enabled);
    $('pushStatus').textContent = enabled ? 'Alerts are on for this device' : 'Connect your phone alerts';
    $('pushHelp').textContent = enabled ? 'New tips will appear in your notifications. You can manage alerts here.'
        : isIOS && !standalone ? 'Open Cerney Tips from your Home Screen to enable iPhone notifications.'
        : !supported ? 'Use Safari on your iPhone, add this page to your Home Screen, then open that icon.'
        : Notification.permission === 'denied' ? 'Notifications are blocked. Allow them for Cerney Tips in your device settings, then refresh.'
        : 'Allow notifications to receive new tips, even when the app is closed.';
    show('enable',supported && !(isIOS && !standalone) && Notification.permission !== 'denied' && !enabled);
    show('disable',!!local || state.subscribed);
}
function load() {
    if (loadRequest) return loadRequest;
    loadRequest = loadInbox().finally(()=>{loadRequest = null;});
    return loadRequest;
}
async function loadInbox() {
    clearTimeout(retryTimer);
    show('install',isIOS && !standalone);
    const version = sessionVersion;
    // Each endpoint authenticates independently. Recent tips need not wait for
    // the separate notification configuration request or service worker setup.
    const status = api('status').then(data=>{
        if (version !== sessionVersion) return;
        state = data;
        show('sessionHelp',state.expiresAt === null);
    });
    const inbox = loadTips();
    const selected = tipId ? openTip() : Promise.resolve();
    const results = await Promise.allSettled([status, inbox, selected]);
    if (version !== sessionVersion) return;
    const failure = results.find(r=>r.status === 'rejected');
    if (failure) message(failure.reason.message,true);
    else message();
    // Notification settings are prepared only when opened; registration still
    // checks for service-worker updates without holding up the inbox.
    prepareNotifications().then(()=>{if(version===sessionVersion && state && $('notificationSettings').open) return updateControls();}).catch(()=>{registration = null;});
}
$('notificationSettings').addEventListener('toggle',async()=>{
    if (!$('notificationSettings').open || !state) return;
    try { await prepareNotifications(); if (state) await updateControls(); }
    catch { if (state) { registration=null; await updateControls(); } }
});
function dateLabel(value) { return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)); }
function folderURL(value) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com' || u.port || u.username || u.password
            || !/^\/drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]+$/.test(u.pathname)) return null;
        return u.origin + u.pathname;
    } catch { return null; }
}
function folderLink(tip) {
    const a=document.createElement('a'); a.className='folder';
    const url=folderURL(tip.driveUrl);
    a.textContent=isIOS ? 'Open in Drive' : 'Open folder';
    // Keep the app handoff inside a real tap. Never substitute a timed web
    // fallback: a slow app launch must not unexpectedly open Drive in Safari.
    a.href=isIOS ? 'googledrive://' + url : url;
    a.rel='noreferrer';
    if (!isIOS) a.target='_blank';
    return a;
}
async function loadDevices() {
    const version=sessionVersion; const data=await api('devices'); if(version!==sessionVersion)return; $('devices').replaceChildren();
    for(const device of data.devices) {
        const row=document.createElement('div');row.className='tip';
        const label=document.createElement('p');label.textContent=`${device.current?'This device':device.label} · Connected ${dateLabel(device.createdAt)}`;row.append(label);
        if(!device.current) {
            const button=document.createElement('button');button.className='secondary';button.textContent='Disconnect';
            button.addEventListener('click',async()=>{
                if(!confirm(`Disconnect ${device.label}? It will need to sign in again, and its alerts will stop.`))return;
                button.disabled=true;
                try{await api('revoke-device',{id:device.id});await loadDevices();message('That device is disconnected.');}
                catch(e){message(e.message,true);button.disabled=false;}
            });row.append(button);
        }
        $('devices').append(row);
    }
}
$('showDevices').addEventListener('click',()=>loadDevices().catch(e=>message(e.message,true)));
function loadTips() {
    if (inboxRequest) return inboxRequest;
    inboxRequest=fetchTips().finally(()=>{inboxRequest=null; $('refresh').disabled=false;});
    return inboxRequest;
}
async function fetchTips() {
    clearTimeout(inboxTimer);
    const version=sessionVersion;
    $('refresh').disabled=true;
    $('inboxStatus').textContent=$('tips').children.length ? 'Updating…' : 'Loading recent tips…';
    let data;
    try { data=await api('list'); }
    catch(e) {
        if (version===sessionVersion) $('inboxStatus').textContent='Could not update. Tap Refresh to retry.';
        throw e;
    }
    if (version!==sessionVersion) return;
    state = state || {};
    show('login',false); show('intro',false); show('connected',true);
    message(); $('tips').replaceChildren(); show('empty',!data.tips.length);
    for(const tip of data.tips) {
        const row=document.createElement('article');row.className='tip';
        const info=document.createElement('div'); const title=document.createElement('h3');title.textContent=(tip.type==='story'?'Story submission':'Tipline upload')+(tip.incomplete?' · Incomplete':'');
        const time=document.createElement('time');time.dateTime=tip.receivedAt;time.textContent=dateLabel(tip.receivedAt);info.append(title,time);row.append(info);
        if(folderURL(tip.driveUrl)) row.append(folderLink(tip)); else {const status=document.createElement('span');status.className='state';status.textContent=tip.status==='review'?'Needs review':'Files processing';row.append(status);}
        $('tips').append(row);
    }
    $('inboxStatus').textContent=`${data.tips.length} recent ${data.tips.length===1?'tip':'tips'} · Updated ${new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(new Date())}`;
    // Keep a newly arrived photo current without requiring manual refresh.
    if (!document.hidden) {
        const processing=data.tips.some(t=>!folderURL(t.driveUrl) && t.status==='processing' && Date.parse(t.receivedAt)>Date.now()-3600000);
        inboxTimer=setTimeout(()=>loadTips().catch(e=>message(e.message,true)),processing ? 3000 : 30000);
    }
}
async function openTip() {
    if (!/^[a-f0-9]{64}$/.test(tipId || '')) return;
    const version=sessionVersion;
    const {tips:[tip]}=await api('tip',{id:tipId});
    if(version!==sessionVersion || !tip) return false;
    state=state || {};
    show('login',false); show('intro',false); show('connected',true);
    if(folderURL(tip.driveUrl)) {
        show('selected',true);
        const title=document.createElement('h2');title.textContent='Your tip is ready to open';
        const text=document.createElement('p');text.textContent=isIOS ? 'Tap below to open this folder in the Google Drive app.' : 'Open this tip’s Google Drive folder.';
        $('selected').replaceChildren(title,text,folderLink(tip));
        return true;
    }
    show('selected',true); $('selected').replaceChildren();
    const title=document.createElement('h2');title.textContent='Your tip has arrived';const text=document.createElement('p');text.textContent=tip.status==='review'?'This submission needs review before its files can be copied to Drive.':'Its files are still being copied to Google Drive. The Open in Drive button will appear here when the folder is ready.';
    $('selected').append(title,text);
    if(tip.status!=='review' && openAttempts++<24) retryTimer=setTimeout(()=>openTip().catch(e=>message(e.message,true)),5000);
    else if(tip.status!=='review') { const note=document.createElement('p'); note.textContent='The transfer is taking longer than usual. Refresh this page to check again.'; $('selected').append(note); }
}
$('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();const button=e.submitter;button.disabled=true;message('Signing in…');
    try {
        const response=await fetch('/api/admin-auth',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});
        const result=await response.json();if(!response.ok)throw new Error(result.error || 'Could not sign in.');
        await api('pair');$('password').value='';await load();
    }catch(error){message(error.message,true);}finally{button.disabled=false;}
});
$('enable').addEventListener('click',async()=>{
    $('enable').disabled=true;
    try {
        // Called directly in the tap handler so iOS sees the user's gesture.
        const permission=await Notification.requestPermission();
        if(permission!=='granted')throw new Error('Notifications were not enabled. You can allow them in device settings.');
        const existing=await manager().getSubscription();
        const subscription=existing || await manager().subscribe({userVisibleOnly:true,applicationServerKey:bytes(state.publicKey)});
        await api('subscribe',{subscription:subscription.toJSON()});state.subscribed=true;await updateControls();message('Alerts enabled for new tips.');
    }catch(e){message(e.message,true);}finally{$('enable').disabled=false;}
});
async function removeLocalSubscription() {
    try { const subscription=await manager()?.getSubscription(); if(subscription) await subscription.unsubscribe(); }
    catch { /* The server already stopped delivery or revoked this device. */ }
}
$('disable').addEventListener('click',async()=>{try{await api('unsubscribe');state.subscribed=false;await removeLocalSubscription();await updateControls();message('Alerts are off on this device.');}catch(e){message(e.message,true);}});
$('refresh').addEventListener('click',async()=>{try{await loadTips();if(tipId){clearTimeout(retryTimer);openAttempts=0;await openTip();}message('Inbox updated.');}catch(e){message(e.message,true);}});
$('logout').addEventListener('click',async()=>{try{await api('logout');clearSession();await removeLocalSubscription();location.replace('/tip-alerts/');}catch(e){message(e.message,true);}});
document.addEventListener('visibilitychange',()=>{
    if(document.hidden) { clearTimeout(inboxTimer); clearTimeout(retryTimer); }
    else if(state) load();
});
load();

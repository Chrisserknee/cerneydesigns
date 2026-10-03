'use strict';
const $ = id => document.getElementById(id);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let state, registration, retryTimer, inboxTimer, openAttempts = 0;
const tipId = new URLSearchParams(location.search).get('tip');
const show = (id, visible) => { $(id).hidden = !visible; };
function message(text='', error=false) { $('message').textContent=text; $('message').classList.toggle('error',error); }
async function api(op, data={}) {
    const response = await fetch('/api/tip-alerts',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({op,...data})});
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'Something went wrong. Please try again.'); error.status=response.status; throw error; }
    return result;
}
function bytes(base64) { return Uint8Array.from(atob(base64.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)); }
function manager() { return registration?.pushManager; }
async function prepareNotifications() {
    if ('serviceWorker' in navigator) registration = await navigator.serviceWorker.register('/tip-alerts/sw.js',{scope:'/tip-alerts/'});
    if (registration) registration = await navigator.serviceWorker.ready;
}
async function updateControls() {
    const supported = !!manager() && 'Notification' in window;
    const local = supported ? await manager().getSubscription() : null;
    const enabled = !!local && state.subscribed && Notification.permission === 'granted';
    $('statusDot').classList.toggle('enabled',enabled);
    $('pushStatus').textContent = enabled ? 'Alerts are on for this device' : 'Connect your phone alerts';
    $('pushHelp').textContent = enabled ? 'New tips will appear in your notifications. Use a test alert to check delivery.'
        : isIOS && !standalone ? 'Open Cerney Tips from your Home Screen to enable iPhone notifications.'
        : !supported ? 'Use Safari on your iPhone, add this page to your Home Screen, then open that icon.'
        : Notification.permission === 'denied' ? 'Notifications are blocked. Allow them for Cerney Tips in your device settings, then refresh.'
        : 'Allow notifications to receive new tips, even when the app is closed.';
    show('enable',supported && !(isIOS && !standalone) && Notification.permission !== 'denied' && !enabled);
    show('test',enabled); show('disable',!!local || state.subscribed);
}
async function load() {
    clearTimeout(retryTimer);
    show('install',isIOS && !standalone);
    try {
        state = await api('status');
        show('sessionHelp',state.expiresAt === null);
        show('login',false); show('intro',false); show('connected',true);
        try { await prepareNotifications(); } catch { registration = null; }
        await updateControls(); await loadTips();
        message();
        if (new URLSearchParams(location.search).has('test')) { $('testResult').textContent='Test alert opened successfully on this device.'; show('testResult',true); }
        if (tipId) await openTip();
    } catch(e) {
        if (e.status === 401) { show('login',true); show('intro',true); show('connected',false); message(); }
        else message(e.message,true);
    }
}
function dateLabel(value) { return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)); }
function folderLink(tip, label='Open folder') { const a=document.createElement('a'); a.className='folder'; a.textContent=label; a.href=tip.driveUrl; a.rel='noreferrer'; return a; }
async function loadTips() {
    clearTimeout(inboxTimer);
    const data=await api('list'); $('tips').replaceChildren(); show('empty',!data.tips.length);
    for(const tip of data.tips) {
        const row=document.createElement('article');row.className='tip';
        const info=document.createElement('div'); const title=document.createElement('h3');title.textContent=(tip.type==='story'?'Story submission':'Tipline upload')+(tip.incomplete?' · Incomplete':'');
        const time=document.createElement('time');time.dateTime=tip.receivedAt;time.textContent=dateLabel(tip.receivedAt);info.append(title,time);row.append(info);
        if(tip.driveUrl) row.append(folderLink(tip)); else {const status=document.createElement('span');status.className='state';status.textContent=tip.status==='review'?'Needs review':'Files processing';row.append(status);}
        $('tips').append(row);
    }
    // Keep a newly arrived photo current without requiring manual refresh.
    if (!document.hidden && data.tips.some(t=>!t.driveUrl && t.status==='processing' && Date.parse(t.receivedAt)>Date.now()-3600000)) {
        inboxTimer=setTimeout(()=>loadTips().catch(e=>message(e.message,true)),3000);
    }
}
async function openTip() {
    if (!/^[a-f0-9]{64}$/.test(tipId || '')) return;
    const {tips:[tip]}=await api('tip',{id:tipId});
    if(tip.driveUrl) { location.replace(tip.driveUrl); return; }
    show('selected',true); $('selected').replaceChildren();
    const title=document.createElement('h2');title.textContent='Your tip has arrived';const text=document.createElement('p');text.textContent=tip.status==='review'?'This submission needs review before its files can be copied to Drive.':'Its files are still being copied to Google Drive. This page will open the folder when it is ready.';
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
        await api('subscribe',{subscription:subscription.toJSON()});state.subscribed=true;await updateControls();message('Alerts enabled. Send a test alert to check your phone.');
    }catch(e){message(e.message,true);}finally{$('enable').disabled=false;}
});
$('test').addEventListener('click',async()=>{
    $('test').disabled=true;
    try {await api('test');$('testResult').textContent='Test accepted by the push service. Check your notifications and tap the test alert.';show('testResult',true);message();}
    catch(e){message(e.message,true);}finally{$('test').disabled=false;}
});
$('disable').addEventListener('click',async()=>{try{await api('unsubscribe');const subscription=await manager()?.getSubscription();if(subscription)await subscription.unsubscribe();state.subscribed=false;await updateControls();message('Alerts are off on this device.');}catch(e){message(e.message,true);}});
$('refresh').addEventListener('click',async()=>{try{await loadTips();if(tipId){clearTimeout(retryTimer);openAttempts=0;await openTip();}message('Inbox updated.');}catch(e){message(e.message,true);}});
$('logout').addEventListener('click',async()=>{try{await api('logout');const subscription=await manager()?.getSubscription();if(subscription)await subscription.unsubscribe();clearTimeout(retryTimer);location.replace('/tip-alerts/');}catch(e){message(e.message,true);}});
document.addEventListener('visibilitychange',()=>{
    if(document.hidden) clearTimeout(inboxTimer);
    else if(state) load();
});
load();

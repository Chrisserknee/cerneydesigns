'use strict';
const CLIENT_RELEASE='2026-10-25-field-notebooks-15b';
const $ = id => document.getElementById(id);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let renderedTips, state, registration, retryTimer, inboxTimer, inboxRequest, loadRequest, sessionVersion = 0, openAttempts = 0;
const thumbnails = new TipThumbnails(api);
let inboxSnapshot = {tips:[],reports:[]};
let savedStories = new Set();
try { savedStories = new Set(JSON.parse(localStorage.getItem('cerney-saved-stories') || '[]').filter(x=>/^[a-f0-9]{64}$/.test(x)).slice(0,200)); } catch {}
// Stories Chris has finished with. Opaque IDs only, kept on this device.
let doneStories = new Set();
try { doneStories = new Set(JSON.parse(localStorage.getItem('cerney-done-stories') || '[]').filter(x=>/^[a-f0-9]{64}$/.test(x)).slice(0,400)); } catch {}
let reviewQueue=null, reviewIndex=0;
const reportStates={queued:'Queued',analyzing:'Analyzing media',awaiting_editor:'Preparing report',editing:'Editing',rendering:'Rendering',qc_pending:'Checking draft',ready:'Draft ready',approved:'Approved',needs_review:'Needs review',held:'Held for review',declined:'Tip saved',paused:'Paused',failed:'Processing stopped'};
function workflow(tip) {
    if(['needs_review','held','failed','paused'].includes(tip.reportState) || tip.status==='review') return 'attention';
    if(tip.draftDelivered && ['ready','approved'].includes(tip.reportState)) return 'ready';
    return 'processing';
}
function sourceURL(value) {
    try { const u=new URL(value); if(u.protocol!=='https:' || u.username || u.password || u.port || !['www.facebook.com','facebook.com'].includes(u.hostname)) return null;
        if(!(/\/posts\/[^/]+/.test(u.pathname) || /\/videos\/[^/]+/.test(u.pathname) || /^\/reel\/\d+\/?$/.test(u.pathname) || (u.pathname==='/watch/' && /^\d+$/.test(u.searchParams.get('v') || '')) || (u.pathname==='/permalink.php' && /^\d+$/.test(u.searchParams.get('story_fbid') || ''))))return null;
        u.hash=''; return u.href;
    } catch {return null;}
}
function videoURL(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='drive.google.com'&&!u.username&&!u.password&&!u.port&&/^\/file\/d\/[A-Za-z0-9_-]{10,200}\/view$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}}
// Stories are grouped by what they need from Chris, most urgent first.
const storyGroups=[['attention','Needs attention'],['ready','Draft ready'],['processing','In progress'],['done','Done']];
const statusChips=[['chipAll','all'],['chipAttention','attention'],['chipReady','ready'],['chipProcessing','processing'],['chipDone','done'],['chipSaved','saved']];
const groupOf=tip=>doneStories.has(tip.id) ? 'done' : workflow(tip);
// A story is reviewable when there is a draft, caption or script to check.
const reviewable=tip=>!doneStories.has(tip.id) && ['attention','ready'].includes(workflow(tip)) && !!(videoURL(tip.videoUrl) || tip.instagramDescription || tip.voiceover);
const GROUP_PAGE=10, groupLimits=new Map();
let statusFilter='all';
function matchesSearch(tip) {
    const q=String($('storySearch').value || '').trim().toLocaleLowerCase();
    return !q || [tip.title,tip.summary,tip.location,tip.agency,tip.county].join(' ').toLocaleLowerCase().includes(q);
}
function matchesFilter(tip,filter) { return filter==='all' || (filter==='saved' ? savedStories.has(tip.id) : groupOf(tip)===filter); }
function toggleDone(tip) {
    if(!/^[a-f0-9]{64}$/.test(tip.id))return;
    if(doneStories.has(tip.id))doneStories.delete(tip.id);else doneStories.add(tip.id);
    try{localStorage.setItem('cerney-done-stories',JSON.stringify([...doneStories].slice(-400)));}catch{}
    renderInbox();
}
function paragraph(parent,text,className='') {const p=document.createElement('p');p.textContent=text;p.className=className;parent.append(p);return p;}
function reportDetails(tip,parent) {
    const url=sourceURL(tip.sourceUrl);
    if(url) { const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.className='source-link';a.textContent='Open original Facebook post ↗';parent.append(a); }
    if(!tip.agency && !tip.sourceText && !tip.verificationNotes?.length && !tip.reportRevision)return;
    const details=document.createElement('details');details.className='story-details';
    const title=document.createElement('summary');title.textContent='Source & reporting notes';details.append(title);
    if(tip.agency)paragraph(details,tip.agency+(tip.county?' · '+tip.county+' County':''),'detail-agency');
    if(tip.sourceKind==='official_email')paragraph(details,'Source: official agency email. The original is retained in the report folder.');
    if(tip.publishedAt && Number.isFinite(Date.parse(tip.publishedAt)))paragraph(details,'Source published: '+dateLabel(tip.publishedAt));
    if(tip.publicationTimeNote)paragraph(details,tip.publicationTimeNote,'time-note');
    if(tip.sourceText){const quote=document.createElement('blockquote');quote.textContent=tip.sourceText;details.append(quote);if(tip.sourceTextTruncated)paragraph(details,'Source excerpt. Open the original post or report folder for the complete release.','small muted');}
    if(tip.verificationNotes?.length){paragraph(details,'Review before publishing','detail-agency');for(const note of tip.verificationNotes)paragraph(details,note);}
    if(tip.durationSeconds)paragraph(details,'Video length: '+tip.durationSeconds+' seconds','small muted');
    if(tip.reportRevision)paragraph(details,'Report revision '+tip.reportRevision+(tip.reportEdition?' · Edition '+tip.reportEdition:''),'small muted');
    parent.append(details);
}
function paintMonitor(health) {
    const summary=$('monitorSummary'),body=$('monitorDetails');body.replaceChildren();
    if(!health || !Number.isFinite(Date.parse(health.updatedAt))) {summary.textContent='Monitoring status unavailable';paragraph(body,'The inbox can update while collection is stopped. No recent monitor health has been received.');return;}
    const stale=Date.now()-Date.parse(health.updatedAt)>5*60000;
    const overdue=!health.lastAttemptAt || Date.now()-Date.parse(health.lastAttemptAt)>150*60000;
    summary.textContent=stale?'Monitoring status is out of date':overdue?'Collection check overdue':health.collectionStatus==='blocked'?'Facebook needs attention':health.collectionStatus==='catching_up'?'Facebook collection catching up':'Agency monitoring';
    paragraph(body,health.lastAttemptAt?'Last monitor check: '+dateLabel(health.lastAttemptAt):'No Facebook check has been recorded yet.');
    paragraph(body,`${health.agencyCount || 0} registered sources · ${health.pendingCount || 0} releases pending`);
    if(health.lastCompletedAt)paragraph(body,'Last finished collection run: '+dateLabel(health.lastCompletedAt));
    if(health.reason)paragraph(body,health.reason);
    if(health.producer){const p=health.producer;const old=Date.now()-Date.parse(p.observedAt)>5*60000;paragraph(body,old?'Production status is out of date.':`${p.activeCount || 0} reports being prepared · ${p.waitingCount || 0} waiting to start`);if(p.resumeCount || p.failedCount)paragraph(body,`${p.resumeCount || 0} saved report chats need recovery · ${p.failedCount || 0} render failures. Existing quality holds stay in place; new jobs continue through the producer.`, 'production-attention');}
    paragraph(body,'Checks rotate across agencies. Hourly 8 a.m.–11 p.m.; 1, 3, 5 and 7 a.m. overnight, Pacific. The Mac and signed-in Safari must be available.','small muted');
}
// An ordinary launch opens the current inbox. Only an explicit notification
// link selects a story; a remembered old selection must not hide new arrivals.
let tipId = new URLSearchParams(location.search).get('tip');
const show = (id, visible) => { $(id).hidden = !visible; };
function message(text='', error=false) { $('message').textContent=text; $('message').classList.toggle('error',error); }
function clearSession({expired=false}={}) {
    try { localStorage.removeItem('cerney-open-tip'); } catch {}
    thumbnails.reset();
    globalThis.CerneyStoryRequests?.clear();
    // Expiring authentication must hide private work without destroying a take.
    if(expired) globalThis.CerneyNewsroom?.suspend();
    else globalThis.CerneyNewsroom?.clear();
    state = null; renderedTips=null; inboxSnapshot={tips:[],reports:[]}; sessionVersion++; message(); resetPull(); closeReview();
    $('inboxStatus').textContent = '';
    clearTimeout(retryTimer); clearTimeout(inboxTimer);
    for (const id of ['tips','reports','devices','selected']) $(id).replaceChildren();
    show('reportsSection',false);$('reportsStatus').textContent='';
    show('selected',false); show('connected',false); show('login',true); show('intro',true);
}
async function api(op, data={}, options={}) {
    const response = await fetch('/api/tip-alerts',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',signal:options.signal || AbortSignal.timeout(15000),body:JSON.stringify({op,...data})});
    let result;
    try { result = await response.json(); }
    catch(error) {
        // An upstream gateway may return HTML or an empty body with its 5xx.
        // Preserve that status so transient preview failures can still retry.
        if(!response.ok) {
            if(response.status===401) clearSession({expired:true});
            const unavailable=new Error('Could not load the inbox. Please try again.');
            unavailable.status=response.status; throw unavailable;
        }
        throw error;
    }
    if (!response.ok) { if (response.status === 401) clearSession({expired:true}); const error = new Error(result?.error || 'Something went wrong. Please try again.'); error.status=response.status; throw error; }
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
    // The list endpoint authenticates and supplies session information itself.
    // Fetch push configuration only when notification settings are opened.
    const results = await Promise.allSettled([loadTips(), tipId ? openTip() : Promise.resolve()]);
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
    try {
        const version=sessionVersion;
        const [data]=await Promise.all([api('status'),prepareNotifications()]);
        if(version!==sessionVersion)return; state=data; await updateControls();
    }
    catch { if (state) { registration=null; await updateControls(); } }
});
function dateLabel(value) { return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)); }
function shortDate(value) { return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)); }
// Source stays independent of report status: Claude can prepare either kind.
function sourceClass(tip) { return tip.type==='incident' ? 'source-found' : 'source-community'; }
function sourceBadge(tip) {
    const badge=document.createElement('p');badge.className='source-badge';
    badge.textContent=tip.type==='incident' ? 'Found report' : tip.sourceKind==='google_voice' ? 'Google Voice tip' : 'Community tip';
    return badge;
}
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
function loadTips({quiet=false}={}) {
    if (inboxRequest) return inboxRequest;
    inboxRequest=fetchTips(quiet).finally(()=>{inboxRequest=null;});
    return inboxRequest;
}
async function fetchTips(quiet) {
    clearTimeout(inboxTimer);
    const version=sessionVersion;
    if (!quiet) $('inboxStatus').textContent=$('tips').children.length ? 'Updating…' : 'Loading community tips…';
    if (!quiet) $('inboxFreshness').textContent='Checking for new tips…';
    let data;
    try { data=await api('list'); }
    catch(e) {
        if (version===sessionVersion) {
            $('inboxStatus').textContent='Could not update. Retrying automatically…';
            $('inboxFreshness').textContent='Could not check for new tips. Retrying automatically…';
            scheduleInbox(10000);
        }
        throw e;
    }
    if (version!==sessionVersion) return;
    state = {...state,expiresAt:data.expiresAt};
    show('sessionHelp',data.expiresAt===null);
    show('login',false); show('intro',false); show('connected',true);
    const reports=Array.isArray(data.reports) ? data.reports : data.tips.filter(t=>t.type==='incident');
    const tips=data.tips.filter(t=>t.type!=='incident');
    message(); show('empty',!tips.length);show('reportsSection',reports.length>0);show('foundReportsLink',reports.length>0);
    inboxSnapshot={tips,reports};
    const latest=tips.filter(tip=>Number.isFinite(Date.parse(tip.receivedAt))).reduce((newest,tip)=>!newest || Date.parse(tip.receivedAt)>Date.parse(newest.receivedAt) ? tip : newest,null);
    show('latestTipButton',!!latest);
    if(latest) $('latestTipButton').textContent='Latest community tip · '+shortDate(latest.receivedAt)+' · '+(latest.title || 'Tipline upload');
    paintMonitor(data.monitor);
    globalThis.CerneyStoryRequests?.update(data.storyRequests || [],data.storyRequestMonitor);
    globalThis.CerneyNewsroom?.refresh(api);
    renderInbox();
    const updated=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(new Date());
    $('reportsStatus').textContent=`${reports.length} found video ${reports.length===1?'report':'reports'} · Updated ${updated}`;
    $('inboxStatus').textContent=`${tips.length} community ${tips.length===1?'tip':'tips'} · Updated ${updated}`;
    $('inboxFreshness').textContent=`Inbox checked ${updated} · Updates automatically`;
    // Keep a newly arrived photo current without requiring manual refresh.
    if (!document.hidden) {
        const processing=data.tips.some(t=>!folderURL(t.driveUrl) && t.status==='processing' && Date.parse(t.receivedAt)>Date.now()-3600000);
        scheduleInbox(processing ? 3000 : 30000);
    }
}
function renderInbox() {
    const {tips,reports}=inboxSnapshot, all=[...reports,...tips];
    $('readyCount').textContent=all.filter(t=>groupOf(t)==='ready').length;
    $('attentionCount').textContent=all.filter(t=>groupOf(t)==='attention').length;
    const queued=all.filter(reviewable).length;$('reviewStartCount').textContent=queued;show('reviewStart',queued>0);
    $('totalCount').textContent=all.length;$('foundCount').textContent=reports.length;$('communityCount').textContent=tips.length;
    const searched=all.filter(matchesSearch);
    for(const [id,filter] of statusChips) {
        $(id+'Count').textContent=searched.filter(t=>matchesFilter(t,filter)).length;
        $(id).setAttribute('aria-pressed',String(statusFilter===filter));$(id).classList.toggle('active',statusFilter===filter);
    }
    const signature=JSON.stringify({tips,reports,q:$('storySearch').value,status:statusFilter,sort:$('storySort').value,saved:[...savedStories],done:[...doneStories],limits:[...groupLimits]});
    if(signature===renderedTips)return;
    thumbnails.reset();$('tips').replaceChildren();$('reports').replaceChildren();
    let shown=0;
    for(const [id,records] of [['reports',reports],['tips',tips]]) {
        const filtered=records.filter(t=>matchesSearch(t) && matchesFilter(t,statusFilter));
        show(id==='reports'?'reportsEmpty':'tipsEmpty',!filtered.length);shown+=filtered.length;
        const sort=$('storySort').value || 'newest';
        const groups=sort==='status' ? storyGroups : [['chronological',sort==='oldest'?'Oldest first':'Newest first']];
        for(const [key,label] of groups) {
            const members=filtered.filter(t=>key==='chronological' || groupOf(t)===key).sort((a,b)=>(sort==='oldest'?1:-1)*(Date.parse(a.receivedAt)-Date.parse(b.receivedAt)));
            if(members.length) $(id).append(storyGroup(id+':'+key,label,members));
        }
    }
    $('filterStatus').textContent=shown===all.length?'Showing all '+shown+' recent stories':shown+' of '+all.length+' stories match';
    renderedTips=signature;
    paintReview();
}
function storyGroup(key,label,members) {
    const limit=groupLimits.get(key) || GROUP_PAGE;
    const grouped=key.startsWith('tips:') && statusFilter==='all' && !($('storySearch').value||'').trim() && $('storySort').value!=='oldest' && globalThis.CerneyConversations;
    const units=grouped ? globalThis.CerneyConversations.groups(members) : members;
    const section=document.createElement('section');section.className='story-group group-'+key.split(':')[1];
    const heading=document.createElement('div');heading.className='group-heading';
    const title=document.createElement('h3');title.textContent=label;const count=document.createElement('span');count.textContent=String(members.length);heading.append(title,count);
    const list=document.createElement('div');list.className='story-list';
    for(const item of units.slice(0,limit)) list.append(grouped ? item.messages.length>1 ? conversationCard(item) : storyCard(item.latest) : storyCard(item));
    section.append(heading,list);
    if(units.length>limit) {
        const more=document.createElement('button');more.type='button';more.className='secondary show-more';
        more.textContent=`Show ${Math.min(GROUP_PAGE,units.length-limit)} more · ${units.length-limit} remaining`;
        more.addEventListener('click',()=>{groupLimits.set(key,limit+GROUP_PAGE);renderInbox();});section.append(more);
    }
    return section;
}
function conversationCard(group) {
    const row=document.createElement('details');row.className='tip tip-card voice-conversation';
    const summary=document.createElement('summary'),badge=document.createElement('small'),title=document.createElement('h4'),latest=document.createElement('p');
    badge.textContent=`Google Voice · ${group.messages.length} messages · ${shortDate(group.latest.receivedAt)}`;
    title.textContent=group.context.title||globalThis.CerneyConversations.text(group.context).slice(0,120);
    latest.textContent='Latest: '+globalThis.CerneyConversations.text(group.latest).slice(0,300);summary.append(badge,title,latest);row.append(summary);
    let opened=false;row.addEventListener('toggle',()=>{if(!row.open||opened)return;opened=true;paragraph(row,'Incoming messages from the same email conversation. Source claims are not independently verified.','small muted');for(const tip of group.messages)row.append(storyCard(tip));});return row;
}
function storyCard(tip) {
    const row=document.createElement('article');row.className='tip tip-card '+sourceClass(tip);
    const body=document.createElement('div');body.className='tip-body';const info=document.createElement('div');
    const meta=document.createElement('div');meta.className='story-meta';meta.append(sourceBadge(tip));
    const badge=document.createElement('span');badge.className='workflow-badge '+workflow(tip);badge.textContent=reportStates[tip.reportState] || (tip.status==='review'?'Needs review':'Tip received');meta.append(badge);info.append(meta);
    const title=document.createElement('h4');title.textContent=(tip.title || (tip.type==='story'?'Story submission':'Tipline upload'))+(tip.incomplete?' · Incomplete':'');info.append(title);
    if(tip.agency)paragraph(info,tip.agency,'agency-name');
    if(tip.mediaSummary)paragraph(info,tip.mediaSummary,'small muted');
    const time=document.createElement('time');time.dateTime=tip.receivedAt;time.textContent='Received '+shortDate(tip.receivedAt);time.title=dateLabel(tip.receivedAt);info.append(time);
    if(tip.summary) {
        const summary=paragraph(info,tip.summary,'tip-summary');
        // Long summaries start as three lines so a phone shows more stories at once.
        if(tip.summary.length>140) {
            summary.classList.toggle('clamped',true);
            const more=document.createElement('button');more.type='button';more.className='text-button summary-toggle';more.textContent='More';more.setAttribute('aria-expanded','false');
            more.addEventListener('click',()=>{const open=more.textContent==='More';summary.classList.toggle('clamped',!open);more.textContent=open?'Less':'More';more.setAttribute('aria-expanded',String(open));});
            info.append(more);
        }
    }
    if(tip.location)paragraph(info,'Reported location: '+tip.location,'tip-location');
    paragraph(info,tip.contextSource==='claude'?'Prepared draft · Review before publishing':tip.contextSource==='tipster'?'Submitted context · Not independently verified':'Context pending','tip-provenance');
    const actions=document.createElement('div');actions.className='story-actions';
    if(videoURL(tip.videoUrl)){const v=document.createElement('a');v.className='folder watch-video';v.href=videoURL(tip.videoUrl);v.target='_blank';v.rel='noopener noreferrer';v.textContent='Watch draft'+(tip.durationSeconds?' · '+Math.round(tip.durationSeconds)+'s':'');actions.append(v);}
    if(folderURL(tip.driveUrl)) actions.append(folderLink(tip)); else paragraph(actions,tip.sourceKind==='google_voice'?'Text received from Google Voice':tip.status==='review'?'Files need review':'Files processing','state');
    if(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/[A-Za-z0-9]{1,80}$/.test(tip.sourceMailURL||'')){const original=document.createElement('a');original.href=tip.sourceMailURL;original.target='_blank';original.rel='noopener noreferrer';original.textContent='Open original email';actions.append(original);}
    if(globalThis.CerneyNewsroom?.startStory){const notebook=document.createElement('button');notebook.type='button';notebook.className='secondary';notebook.textContent='Start story notebook';notebook.addEventListener('click',()=>globalThis.CerneyNewsroom.startStory({title:tip.title||'New story',evidence:[{id:tip.id,title:tip.title||'Source submission',excerpt:String(tip.submission?.text||tip.sourceText||tip.description||tip.summary||'No written source context supplied.').slice(0,6000),url:tip.sourceMailURL||tip.sourceUrl||tip.driveUrl,kind:tip.sourceKind||'community_tip',receivedAt:tip.receivedAt}]}));actions.append(notebook);}
    const save=document.createElement('button');save.type='button';save.className='save-story';save.textContent=savedStories.has(tip.id)?'Saved ✓':'Save';save.setAttribute('aria-label',(savedStories.has(tip.id)?'Unsave ':'Save ')+(tip.title || 'story'));save.setAttribute('aria-pressed',String(savedStories.has(tip.id)));
    save.addEventListener('click',()=>{if(savedStories.has(tip.id))savedStories.delete(tip.id);else if(/^[a-f0-9]{64}$/.test(tip.id))savedStories.add(tip.id);try{localStorage.setItem('cerney-saved-stories',JSON.stringify([...savedStories].slice(-200)));}catch{}renderInbox();});
    const finished=doneStories.has(tip.id);const done=document.createElement('button');done.type='button';done.className='mark-done';done.textContent=finished?'Undo done':'Done';done.setAttribute('aria-pressed',String(finished));done.setAttribute('aria-label',(finished?'Mark not done: ':'Mark done: ')+(tip.title || 'story'));
    done.addEventListener('click',()=>toggleDone(tip));actions.append(done,save);info.append(actions);
    body.append(info);row.append(body);reportDetails(tip,row);CerneyReportCopy.appendReportCopy(tip,row);thumbnails.add(tip,row);
    return row;
}
const storyById=id=>[...inboxSnapshot.reports,...inboxSnapshot.tips].find(t=>t.id===id);
// Review mode walks the drafts that need Chris one at a time. The queue is a
// list of opaque IDs frozen when it opens; each story is read fresh from the inbox.
function openReview() {
    const ids=[...inboxSnapshot.reports,...inboxSnapshot.tips].filter(reviewable).sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt)).map(t=>t.id);
    if(!ids.length)return;
    reviewQueue=ids;reviewIndex=0;document.documentElement.classList.toggle('review-open',true);show('reviewMode',true);paintReview();$('reviewClose').focus();
}
function closeReview() {
    reviewQueue=null;document.documentElement.classList.toggle('review-open',false);
    show('reviewMode',false);$('reviewStory').replaceChildren();
}
function paintReview() {
    if(!reviewQueue)return;
    while(reviewIndex<reviewQueue.length && !storyById(reviewQueue[reviewIndex]))reviewIndex++;
    const body=$('reviewStory'),finished=reviewIndex>=reviewQueue.length;
    $('reviewProgress').textContent=finished?'Review complete':`Story ${reviewIndex+1} of ${reviewQueue.length}`;
    show('reviewPrev',reviewIndex>0);show('reviewNext',!finished);show('reviewDone',!finished);
    body.replaceChildren();body.scrollTop=0;
    if(finished) { paragraph(body,'You have been through every draft in this queue. New drafts will appear on the story desk when they arrive.','review-finished'); return; }
    const tip=storyById(reviewQueue[reviewIndex]);
    $('reviewDone').textContent=doneStories.has(tip.id)?'Undo done':'Done & next';
    const card=storyCard(tip);
    for(const part of [...card.children]) if(part.className==='story-details' || part.className==='report-copy') part.open=true;
    body.append(card);
}
$('reviewStart').addEventListener('click',openReview);$('reviewClose').addEventListener('click',()=>{closeReview();$('reviewStart').focus();});
$('reviewPrev').addEventListener('click',()=>{reviewIndex=Math.max(0,reviewIndex-1);paintReview();});
$('reviewNext').addEventListener('click',()=>{reviewIndex++;paintReview();});
$('reviewDone').addEventListener('click',()=>{
    const tip=storyById(reviewQueue?.[reviewIndex]);if(!tip)return;
    // Advance first so the repaint triggered by the change shows the next story.
    if(!doneStories.has(tip.id))reviewIndex++;
    toggleDone(tip);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && reviewQueue)closeReview();});
$('storySearch').addEventListener('input',renderInbox);$('storySort').addEventListener('change',renderInbox);
for(const [id,filter] of statusChips) $(id).addEventListener('click',()=>{statusFilter=filter;renderInbox();});
$('refreshButton').addEventListener('click',async()=>{const b=$('refreshButton');b.disabled=true;try{await refreshInbox();}finally{b.disabled=false;}});
$('latestTipButton').addEventListener('click',()=>{
    dismissSelection();closeReview();statusFilter='all';$('storySearch').value='';$('storySort').value='newest';
    groupLimits.clear();renderInbox();$('communitySection').scrollIntoView({block:'start'});
});
function dismissSelection(){tipId=null;try{localStorage.removeItem('cerney-open-tip');}catch{}history.replaceState(null,'','/tip-alerts/');show('selected',false);$('selected').replaceChildren();}
function dismissButton(){const b=document.createElement('button');b.type='button';b.className='dismiss-selection';b.textContent='Close selected story ×';b.addEventListener('click',dismissSelection);return b;}
async function openTip() {
    if (!/^[a-f0-9]{64}$/.test(tipId || '')) return;
    const version=sessionVersion, requestedId=tipId;
    const {tips:[tip]}=await api('tip',{id:requestedId});
    if(version!==sessionVersion || requestedId!==tipId || !tip) return false;
    state=state || {};
    show('login',false); show('intro',false); show('connected',true);
    $('selected').className='card selected '+sourceClass(tip);
    if(folderURL(tip.driveUrl)) {
        // Retain only the opaque selection, never private copy or media. A
        // Home Screen relaunch still authenticates and reads the report fresh.
        try { localStorage.setItem('cerney-open-tip',requestedId); } catch {}
        show('selected',true);
        const title=document.createElement('h2');title.textContent='Your tip is ready to open';
        const text=document.createElement('p');text.textContent=isIOS ? 'Tap below to open this folder in the Google Drive app.' : 'Open this tip’s Google Drive folder.';
        title.textContent=tip.title || 'Your report is ready';
        $('selected').replaceChildren(dismissButton(),title,sourceBadge(tip),text,folderLink(tip));
        reportDetails(tip,$('selected'));
        CerneyReportCopy.appendReportCopy(tip,$('selected'));
        return true;
    }
    show('selected',true); $('selected').replaceChildren();
    const title=document.createElement('h2');title.textContent='Your tip has arrived';const text=document.createElement('p');text.textContent=tip.status==='review'?'This submission needs review before its files can be copied to Drive.':'Its files are still being copied to Google Drive. The Open in Drive button will appear here when the folder is ready.';
    $('selected').append(dismissButton(),title,sourceBadge(tip),text);
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
function scheduleInbox(delay) {
    clearTimeout(inboxTimer);
    if (!document.hidden) inboxTimer=setTimeout(()=>loadTips({quiet:true}).catch(e=>message(e.message,true)),delay);
}
let refreshRequest, pullStart, pullReady=false, pullFrame, pullDistance=0;
const pullRoot=document.documentElement;
pullRoot.classList.toggle('standalone-app',!!standalone);
function paintPull() {
    pullFrame=null;
    pullRoot.style.setProperty('--pull-distance',`${pullDistance}px`);
    pullRoot.style.setProperty('--pull-opacity',String(Math.min(1,pullDistance/45)));
    pullRoot.style.setProperty('--pull-turn',`${pullDistance*4}deg`);
}
function movePull(distance) {
    pullDistance=distance;
    if(!pullFrame)pullFrame=requestAnimationFrame(paintPull);
}
function resetPull() {
    pullStart=null; pullReady=false;
    pullRoot.classList.toggle('pull-dragging',false);
    if(!refreshRequest) {
        pullRoot.classList.toggle('pull-refreshing',false);
        if(pullFrame)cancelAnimationFrame(pullFrame);
        pullFrame=null; pullDistance=0; paintPull();
        show('pullIndicator',false);
    }
}
function refreshInbox() {
    if(refreshRequest) return refreshRequest;
    $('pullIndicator').textContent='Refreshing'; show('pullIndicator',true);
    pullRoot.classList.toggle('pull-dragging',false);
    pullRoot.classList.toggle('pull-refreshing',true);
    movePull(56);
    refreshRequest=(async()=>{
        try {
            clearTimeout(retryTimer); openAttempts=0;
            await Promise.all([loadTips({quiet:true}),tipId ? openTip() : Promise.resolve()]);
            thumbnails.retryFailed({manual:true});
        } catch(e) { message(e.message,true); }
        finally { refreshRequest=null; resetPull(); }
    })();
    return refreshRequest;
}
// Safari keeps its own native refresh. Only the Home Screen app needs this
// gesture. The indicator is outside layout; dragging changes transforms only.
if(standalone) {
    document.addEventListener('touchstart',event=>{
        resetPull();
        if (!state || refreshRequest || reviewQueue || window.scrollY>0 || event.touches.length!==1
            || (window.visualViewport && window.visualViewport.scale!==1)
            || event.target.closest('button,input,textarea,select,summary')) return;
        pullStart={x:event.touches[0].clientX,y:event.touches[0].clientY};
    },{passive:true});
    document.addEventListener('touchmove',event=>{
        if(!pullStart) return;
        if(event.touches.length!==1 || window.scrollY>0 || !event.cancelable) { resetPull(); return; }
        const dy=event.touches[0].clientY-pullStart.y;
        const dx=Math.abs(event.touches[0].clientX-pullStart.x);
        if(dy<=0 || dx>Math.abs(dy)) { resetPull(); return; }
        event.preventDefault();
        // Diminishing travel gives the pull resistance without moving layout.
        const distance=110*(1-Math.exp(-dy/120));
        const ready=distance>=60;
        if(ready!==pullReady || !$('pullIndicator').textContent)
            $('pullIndicator').textContent=ready ? 'Release to refresh' : 'Pull to refresh';
        pullReady=ready;
        pullRoot.classList.toggle('pull-dragging',true);
        show('pullIndicator',true); movePull(distance);
    },{passive:false});
    document.addEventListener('touchend',()=>{
        if(pullReady && state && !document.hidden) { pullStart=null; pullReady=false; refreshInbox(); }
        else resetPull();
    },{passive:true});
    document.addEventListener('touchcancel',resetPull,{passive:true});
}
// A notification can resume a running iPhone inbox instead of loading a page.
// Only accept a same-origin inbox destination sent through our service worker.
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    if(event.data?.type==='cerney-client-update') {
        if(event.data.release===CLIENT_RELEASE)return;
        if(!document.getElementById('appUpdateNotice')){const notice=document.createElement('div');notice.id='appUpdateNotice';notice.className='app-update-notice';notice.textContent='An app update is ready. ';const reload=document.createElement('button');reload.type='button';reload.textContent='Reload when finished';reload.addEventListener('click',()=>{if(globalThis.CerneyNewsroom?.hasUnsavedWork()){message('Finish and submit your recording or save your notes before reloading.',true);return;}location.reload();});notice.append(reload);document.body.prepend(notice);}return;
    }
    if(event.data?.type!=='cerney-tip-open')return;
    let url;
    try { url=new URL(event.data.url); } catch { return; }
    const alert=url.searchParams.get('alert');
    if(url.origin===location.origin && url.pathname==='/tip-alerts/' && /^[a-f0-9]{64}$/.test(alert || '')) {history.replaceState(null,'',url.pathname+url.search);globalThis.CerneyNewsroom?.refresh(api,true);return;}
    const story=url.searchParams.get('story');
    if(url.origin===location.origin && url.pathname==='/tip-alerts/' && /^[a-f0-9]{64}$/.test(story || '')) {history.replaceState(null,'',url.pathname+url.search);loadTips().catch(e=>message(e.message,true));return;}
    const id=url.searchParams.get('tip');
    if(url.origin!==location.origin || url.pathname!=='/tip-alerts/' || !/^[a-f0-9]{64}$/.test(id || ''))return;
    tipId=id;openAttempts=0;clearTimeout(retryTimer);
    history.replaceState(null,'',url.pathname+url.search);
    openTip().catch(error=>message(error.message,true));
});
window.addEventListener('online',()=>{if(!document.hidden) load();});
$('logout').addEventListener('click',async()=>{if(globalThis.CerneyNewsroom?.hasUnsavedWork()){message('Save your notes and submit or download your recording before signing out.',true);return;}try{await api('logout');clearSession();await removeLocalSubscription();location.replace('/tip-alerts/');}catch(e){message(e.message,true);}});
document.addEventListener('visibilitychange',()=>{
    if(document.hidden) { resetPull(); clearTimeout(inboxTimer); clearTimeout(retryTimer); }
    else if(state) load();
});
load();

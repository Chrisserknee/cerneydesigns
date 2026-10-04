'use strict';
const { randomBytes, randomUUID } = require('node:crypto');
const webpush = require('web-push');
const { onRequest } = require('firebase-functions/v2/https');
const { onObjectFinalized, onObjectMetadataUpdated } = require('firebase-functions/v2/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getStorage } = require('firebase-admin/storage');
const { logger } = require('firebase-functions');
const {defineSecret}=require('firebase-functions/params');
const {gatewayAuthenticated}=require('./request-auth');
const proxySecret=defineSecret('TIP_ALERTS_PROXY_SECRET');
const { SITE, hash, activeDevice, validSubscription, tipRecord, retryTime, notification } = require('./tip-alerts-helpers');
const {sourceContext,displayContext}=require('./tip-inbox-context');
const ROOT = '_tipalerts/v1/';
const bucket = () => getStorage().bucket('tip-line-8c2d7.firebasestorage.app');
const options = {region:'us-west1', memory:'256MiB', timeoutSeconds:120, maxInstances:3};
async function read(name) {
    const file = bucket().file(ROOT + name);
    try {
        const [meta] = await file.getMetadata();
        const [bytes] = await bucket().file(ROOT + name, {generation:meta.generation}).download();
        return {data:JSON.parse(bytes.toString()), generation:meta.generation};
    } catch (e) { if (e.code === 404) return null; throw e; }
}
async function write(name, data, generation) {
    await bucket().file(ROOT + name).save(JSON.stringify(data), {resumable:false, contentType:'application/json',
        metadata:{cacheControl:'no-store'}, ...(generation === undefined ? {} : {preconditionOpts:{ifGenerationMatch:generation}})});
}
async function updateDevice(id, changes) {
    const name = `devices/${id}.json`;
    for (let attempt=0; attempt<3; attempt++) {
        const current = await read(name);
        if (!activeDevice(current?.data)) throw Object.assign(new Error('Device disconnected'), {code:401});
        try { await write(name,{...current.data,...changes},current.generation); return; }
        catch(e) { if(e.code !== 412 || attempt===2) throw e; }
    }
}
async function reserveLogin(clientKey) {
    if (!/^[a-f0-9]{64}$/.test(clientKey || '')) throw Object.assign(new Error('Invalid client'),{code:400});
    const name='security/login-limits.json',windowMs=15*60000;
    for(let attempt=0;attempt<5;attempt++) {
        const now=Date.now(),stored=await read(name);
        const state=stored && now-stored.data.startedAt<windowMs ? stored.data : {startedAt:now,count:0,clients:{}};
        // Account-wide and per-network limits survive cold starts and scaling.
        if(state.count>=40 || (state.clients[clientKey] || 0)>=8)return false;
        const next={...state,count:state.count+1,clients:{...state.clients,[clientKey]:(state.clients[clientKey] || 0)+1}};
        try {await write(name,next,stored?.generation || 0);return true;}
        catch(e) {if(e.code!==412 || attempt===4)throw e;}
    }
}
function deviceLabel(device) {
    return device.label || (device.subscription?.endpoint?.includes('push.apple.com') ? 'iPhone or iPad' : 'Browser');
}
async function config() {
    const existing = await read('config.json');
    if (existing) return existing.data;
    const data = {...webpush.generateVAPIDKeys(), enabledAt:new Date().toISOString()};
    try { await write('config.json', data, 0); return data; }
    catch (e) { if (e.code === 412) return (await read('config.json')).data; throw e; }
}
async function documents(prefix) {
    const [files] = await bucket().getFiles({prefix:ROOT + prefix});
    return (await Promise.all(files.map(f => read(f.name.slice(ROOT.length))))).filter(Boolean).map(r => r.data);
}
// Only tip summaries are cached. Every request still reads the current device
// record, and every inbox refresh lists storage generations to detect changes.
const inboxRecords = new Map();
async function inboxDocuments(prefix='tips/') {
    const [files] = await bucket().getFiles({prefix:ROOT + prefix});
    const names = new Set(files.map(f=>f.name));
    for (const name of inboxRecords.keys()) if (name.startsWith(ROOT+prefix) && !names.has(name)) inboxRecords.delete(name);
    const records = await Promise.all(files.map(async file=>{
        const generation=file.metadata?.generation;
        const cached=inboxRecords.get(file.name);
        if (generation && cached?.generation===generation) return cached.data;
        if (!generation) return (await read(file.name.slice(ROOT.length)))?.data;
        try {
            const [bytes]=await bucket().file(file.name,{generation}).download();
            const data=JSON.parse(bytes.toString());
            if (inboxRecords.size>=1000) inboxRecords.delete(inboxRecords.keys().next().value);
            inboxRecords.set(file.name,{generation,data});
            return data;
        } catch(e) {
            // A record may have been replaced since the listing. Read the new
            // version instead of losing that tip or failing the entire inbox.
            if(e.code===404) return (await read(file.name.slice(ROOT.length)))?.data;
            throw e;
        }
    }));
    return records.filter(Boolean);
}
async function syncTip(object) {
    const record = tipRecord(object);
    if (!record) return null;
    const file=bucket().file(object.name,{generation:object.generation});
    const [raw]=await file.download();
    const initial=JSON.parse(raw.toString());
    let followup;
    try {
        const [bytes]=await bucket().file(object.name.replace('_submission.json','_context_ready.json')).download();
        const context=JSON.parse(bytes.toString());
        if(context.submissionName===object.name && String(context.submissionGeneration)===String(object.generation))
            followup={...context.submission,receivedAt:context.receivedAt};
    } catch(e) { if(e.code!==404)throw e; }
    Object.assign(record,sourceContext(initial,followup));
    const name = `tips/${record.id}.json`;
    for (let attempt=0; attempt<3; attempt++) {
        const old = await read(name);
        const next = {...old?.data, ...record};
        // A stale finalize event cannot revert a completed metadata event.
        if (old?.data.status === 'ready' && record.status === 'processing') {
            next.status = 'ready'; next.driveUrl = old.data.driveUrl;
        }
        if (JSON.stringify(next) === JSON.stringify(old?.data)) return next;
        try { await write(name, next, old?.generation || 0); return next; }
        catch(e) { if(e.code !== 412 || attempt===2) throw e; }
    }
}
async function send(subscription, payload, keys) {
    return webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL:86400, urgency:'high', timeout:15000,
        vapidDetails:{subject:SITE + '/tip-alerts/', publicKey:keys.publicKey, privateKey:keys.privateKey},
    });
}
async function deliver(tip, device, keys) {
    if (!device.subscription || !activeDevice(device)
        || Date.parse(tip.receivedAt) < Math.max(Date.parse(keys.enabledAt), Date.parse(device.subscribedAt))) return;
    const name = `deliveries/${tip.id}-${device.id}.json`;
    const previous = await read(name);
    const now = Date.now();
    if (previous?.data.status === 'sent' || Number(previous?.data.nextAttempt || 0) > now) return;
    const lease = randomUUID();
    const attempt = (previous?.data.attempt || 0) + 1;
    try { await write(name, {tipId:tip.id, deviceId:device.id, status:'sending', attempt, lease, nextAttempt:now + 120000}, previous?.generation || 0); }
    catch(e) { if (e.code === 412) return; throw e; }
    try {
        await send(device.subscription, notification(tip), keys);
        await write(name, {tipId:tip.id, deviceId:device.id, status:'sent', attempt, acceptedAt:new Date().toISOString()});
        logger.info('Web tip alert accepted', {tipId:tip.id, deviceId:device.id});
    } catch(e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
            const current = await read(`devices/${device.id}.json`);
            if (current?.data.subscription?.endpoint === device.subscription.endpoint) {
                await write(`devices/${device.id}.json`, {...current.data, subscription:null, pushExpiredAt:new Date().toISOString()}, current.generation);
            }
            await write(name, {tipId:tip.id, deviceId:device.id, status:'expired', attempt, nextAttempt:now + 86400000});
        } else {
            await write(name, {tipId:tip.id, deviceId:device.id, status:'pending', attempt, lastStatus:Number(e.statusCode) || 0, nextAttempt:retryTime(e, attempt, now)});
            logger.warn('Web tip alert queued for retry', {tipId:tip.id, status:Number(e.statusCode) || 0});
        }
    }
}
async function capture(event) {
    if (!event.data?.name?.startsWith('tips/') || !/\/_(submission|context_ready)\.json$/.test(event.data.name)) return;
    const contextOnly=event.data.name.endsWith('/_context_ready.json');
    const [current] = await bucket().file(event.data.name.replace('_context_ready.json','_submission.json')).getMetadata();
    if (!(await require('./upload-admission').permittedObject(current))) return;
    const tip = await syncTip(current);
    if (!tip || contextOnly) return;
    const keys = await config();
    const devices = await documents('devices/');
    await Promise.all(devices.map(device => deliver(tip, device, keys)));
}
async function authenticate(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    let data;
    try { const [bytes]=await bucket().file(ROOT + `devices/${hash(token)}.json`).download(); data=JSON.parse(bytes.toString()); }
    catch(e) { if(e.code===404)return null; throw e; }
    return activeDevice(data) ? data : null;
}
async function adminVerified(body) {
    if (typeof body.adminCookie !== 'string' || body.adminCookie.length > 2048
        || !/^cc_admin_session=[A-Za-z0-9_.-]+$/.test(body.adminCookie)) return false;
    const res = await fetch(SITE + '/api/admin-auth', {headers:{Cookie:body.adminCookie, 'User-Agent':String(body.userAgent || '').slice(0,512)}, redirect:'error', signal:AbortSignal.timeout(10000)});
    return res.ok && (await res.json()).authenticated === true;
}
async function handleApi(req, res) {
    res.set('Cache-Control','no-store'); res.set('X-Content-Type-Options','nosniff');
    if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed.'});
    if (!req.is('application/json') || req.rawBody?.length > 16384) return res.status(400).json({error:'Invalid request.'});
    const body = req.body || {};
    try {
        if (body.op === 'login-attempt') {
            if(!await reserveLogin(body.clientKey))return res.status(429).json({allowed:false});
            return res.json({allowed:true});
        }
        if (body.op === 'pair') {
            if (!await adminVerified(body)) return res.status(401).json({error:'Please sign in to pair this device.'});
            const token = randomBytes(32).toString('base64url');
            const now = Date.now();
            const ua=String(body.userAgent || '');
            const label=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Macintosh/.test(ua)?'Mac':/Android/.test(ua)?'Android':'Browser';
            const device = {id:hash(token),label,createdAt:new Date(now).toISOString(), sessionPolicy:'until-sign-out', expiresAt:null, subscription:null};
            await write(`devices/${device.id}.json`, device, 0);
            return res.json({token, expiresAt:device.expiresAt});
        }
        const device = await authenticate(body.token);
        if (!device) return res.status(401).json({error:'Sign in to connect this device.'});
        if(body.op === 'devices') {
            const devices=(await documents('devices/')).filter(d=>activeDevice(d));
            return res.json({devices:devices.map(d=>({id:d.id,label:deviceLabel(d),createdAt:d.createdAt,current:d.id===device.id,alertsOn:!!d.subscription}))});
        }
        if(body.op === 'revoke-device') {
            if(!/^[a-f0-9]{64}$/.test(body.id || '') || body.id===device.id)return res.status(400).json({error:'Use Sign out to disconnect this device.'});
            await updateDevice(body.id,{revokedAt:new Date().toISOString(),expiresAt:new Date().toISOString(),subscription:null});
            return res.json({disconnected:true});
        }
        if (body.op === 'status') {
            const keys = await config();
            return res.json({authenticated:true, publicKey:keys.publicKey, subscribed:!!device.subscription, expiresAt:device.expiresAt});
        }
        if (body.op === 'subscribe') {
            if (!validSubscription(body.subscription)) return res.status(400).json({error:'This push subscription is not supported.'});
            const key = await config();
            const data = {...device, subscription:{endpoint:body.subscription.endpoint, keys:{p256dh:body.subscription.keys.p256dh, auth:body.subscription.keys.auth}},
                subscribedAt:device.subscribedAt || new Date().toISOString()};
            await updateDevice(device.id,{subscription:data.subscription,subscribedAt:data.subscribedAt});
            return res.json({subscribed:true, publicKey:key.publicKey});
        }
        if (body.op === 'unsubscribe') {
            await updateDevice(device.id,{subscription:null,subscribedAt:null});
            return res.json({subscribed:false});
        }
        if (body.op === 'logout') {
            await updateDevice(device.id,{revokedAt:new Date().toISOString(),expiresAt:new Date().toISOString(),subscription:null});
            return res.json({authenticated:false});
        }
        if (body.op === 'list' || body.op === 'tip') {
            let tips;
            if (body.op === 'tip') {
                if (!/^[a-f0-9]{64}$/.test(body.id || '')) return res.status(400).json({error:'Invalid tip.'});
                const stored = await read(`tips/${body.id}.json`);
                if (!stored) return res.status(404).json({error:'Tip not found.'});
                // Resolve the current destination even while a storage event is catching up.
                const [latest] = await bucket().file(stored.data.path).getMetadata();
                tips = [await syncTip(latest)];
            } else {
                tips = (await inboxDocuments()).filter(t => Date.parse(t.receivedAt) > Date.now()-30*86400000)
                    .sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt)).slice(0,50);
            }
            const reports=await inboxDocuments('enrichment/');
            const byId=new Map(reports.map(r=>[r.id,r]));
            return res.json({authenticated:true,expiresAt:device.expiresAt,tips:tips.map(t=>displayContext(t,byId.get(t.id))).map(({path,sourceGeneration,sourceTitle,sourceSummary,sourceLocation,contextReceivedAt,...t})=>t)});
        }
        if (body.op === 'test') {
            if (!device.subscription) return res.status(409).json({error:'Enable notifications on this device first.'});
            if (Date.now() - Date.parse(device.lastTestAt || 0) < 30000) return res.status(429).json({error:'Wait 30 seconds before another test.'});
            await updateDevice(device.id,{lastTestAt:new Date().toISOString()});
            const payload = {web_push:8030, notification:{title:'Tip alerts are connected',body:'Tap to open your private tip inbox.',navigate:SITE+'/tip-alerts/?test=1',tag:'tip-alert-test',icon:SITE+'/tip-alerts/icon-192.png',data:{url:SITE+'/tip-alerts/?test=1'}}};
            await send(device.subscription, payload, await config());
            return res.json({accepted:true});
        }
        return res.status(400).json({error:'Unknown request.'});
    } catch(e) {
        if (e.code === 400) return res.status(400).json({error:'Invalid request.'});
        if (e.code === 401) return res.status(401).json({error:'Sign in to connect this device.'});
        logger.error('Tip alerts request failed', {op:body.op, code:Number(e.code || e.statusCode) || 0});
        return res.status(503).json({error:'Temporarily unavailable. Please try again.'});
    }
}
exports.captureWebTip = onObjectFinalized({...options,retry:true},capture);
exports.updateWebTip = onObjectMetadataUpdated({...options,retry:true},capture);
exports.retryWebTips = onSchedule({...options,maxInstances:1,schedule:'every 5 minutes'},async()=>{
    const keys = await config();
    const devices = (await documents('devices/')).filter(d=>d.subscription && activeDevice(d));
    if (!devices.length) return;
    const tips = (await documents('tips/')).filter(t=>Date.parse(t.receivedAt)>Date.now()-7*86400000);
    for (const tip of tips) for (const device of devices) await deliver(tip,device,keys);
});
async function secureHandleApi(req,res) {
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    if(!gatewayAuthenticated(req,proxySecret.value()))return res.status(403).json({error:'Trusted website connection required.'});
    if(req.body?.op==='upload-authorize'){try{const r=await require('./upload-admission').authorize(req.body);return res.status(r.status).json(r.body);}catch{return res.status(503).json({error:'Upload protection unavailable. Please try again.'});}}
    return handleApi(req,res);
}
exports.tipAlertsApi = onRequest({...options,invoker:'public',secrets:[proxySecret]},secureHandleApi);

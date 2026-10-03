'use strict';
const { randomBytes, randomUUID } = require('node:crypto');
const webpush = require('web-push');
const { onRequest } = require('firebase-functions/v2/https');
const { onObjectFinalized, onObjectMetadataUpdated } = require('firebase-functions/v2/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getStorage } = require('firebase-admin/storage');
const { logger } = require('firebase-functions');
const { SITE, hash, activeDevice, validSubscription, tipRecord, retryTime, notification } = require('./tip-alerts-helpers');
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
async function syncTip(object) {
    const record = tipRecord(object);
    if (!record) return null;
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
    if (!event.data?.name?.startsWith('tips/') || !event.data.name.endsWith('/_submission.json')) return;
    const [current] = await bucket().file(event.data.name).getMetadata();
    const tip = await syncTip(current);
    if (!tip) return;
    const keys = await config();
    const devices = await documents('devices/');
    await Promise.all(devices.map(device => deliver(tip, device, keys)));
}
async function authenticate(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const record = await read(`devices/${hash(token)}.json`);
    return activeDevice(record?.data) ? record.data : null;
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
        if (body.op === 'pair') {
            if (!await adminVerified(body)) return res.status(401).json({error:'Please sign in to pair this device.'});
            const token = randomBytes(32).toString('base64url');
            const now = Date.now();
            const device = {id:hash(token), createdAt:new Date(now).toISOString(), sessionPolicy:'until-sign-out', expiresAt:null, subscription:null};
            await write(`devices/${device.id}.json`, device, 0);
            return res.json({token, expiresAt:device.expiresAt});
        }
        const device = await authenticate(body.token);
        if (!device) return res.status(401).json({error:'Sign in to connect this device.'});
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
                tips = (await documents('tips/')).filter(t => Date.parse(t.receivedAt) > Date.now()-30*86400000)
                    .sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt)).slice(0,50);
            }
            return res.json({tips:tips.map(({path,...t})=>t)});
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
exports.tipAlertsApi = onRequest({...options,invoker:'public'},handleApi);

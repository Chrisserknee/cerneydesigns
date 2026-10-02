'use strict';
const { createHash } = require('node:crypto');
const SITE = 'https://www.chriscerney.org';
const hash = value => createHash('sha256').update(value).digest('hex');
function validSubscription(value) {
    try {
        const u = new URL(value.endpoint);
        const allowed = /(^|\.)push\.apple\.com$/.test(u.hostname)
            || u.hostname === 'fcm.googleapis.com'
            || u.hostname === 'updates.push.services.mozilla.com';
        if (!allowed || u.protocol !== 'https:' || u.port || u.username || u.password || value.endpoint.length > 2048) return false;
        return /^[A-Za-z0-9_-]+$/.test(value.keys?.p256dh) && Buffer.from(value.keys.p256dh, 'base64url').length === 65
            && /^[A-Za-z0-9_-]+$/.test(value.keys?.auth) && Buffer.from(value.keys.auth, 'base64url').length === 16;
    } catch { return false; }
}
function driveUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === 'https:' && u.hostname === 'drive.google.com' && !u.username && !u.password
            && /^\/drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]+$/.test(u.pathname) ? u.origin + u.pathname : null;
    } catch { return null; }
}
function tipRecord(object) {
    if (!/^tips\/(?:submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}\/_submission\.json$/.test(object.name || '')) return null;
    const m = object.metadata || {};
    if (!Number.isFinite(Date.parse(object.timeCreated))) return null;
    return {
        id: hash(object.name), path: object.name, receivedAt: object.timeCreated,
        type: object.name.includes('/submit-story_') ? 'story' : 'upload',
        driveUrl: driveUrl(m.driveFolderUrl),
        status: m.processingStatus === 'rejected' ? 'review' : m.driveCopyStatus === 'complete' ? 'ready' : 'processing',
        incomplete: m.incompleteUpload === 'true',
    };
}
function retryTime(error, attempt, now = Date.now()) {
    const raw = error.headers?.['retry-after'];
    const seconds = raw && /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
    const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(raw) - now) || 0;
    const delay = [60000, 300000, 900000, 1800000, 3600000][Math.min(Math.max(attempt - 1, 0), 4)];
    return now + Math.max(delay, serverDelay);
}
function notification(tip, now = Date.now()) {
    const delayed = now - Date.parse(tip.receivedAt) > 10 * 60000;
    const received = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles', month:'short', day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(tip.receivedAt));
    return {
        web_push: 8030,
        notification: {
            title: delayed ? 'Tip received earlier' : 'New tip received',
            body: `Received ${received}.${tip.incomplete ? ' Incomplete upload saved.' : ''} Tap to review.`,
            navigate: `${SITE}/tip-alerts/?tip=${tip.id}`,
            tag: `tip-${tip.id}`, icon: `${SITE}/tip-alerts/icon-192.png`,
            data: { url: `${SITE}/tip-alerts/?tip=${tip.id}` },
        },
    };
}
module.exports = { SITE, hash, validSubscription, driveUrl, tipRecord, retryTime, notification };

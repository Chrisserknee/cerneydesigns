'use strict';

const { createHmac } = require('node:crypto');

function moderationConfig() {
    const secret = String(process.env.SPOTLIGHT_MODERATION_PROXY_SECRET || '');
    const url = String(process.env.SPOTLIGHT_MODERATION_URL || '');
    const allowed = url === 'https://us-west1-tip-line-8c2d7.cloudfunctions.net/spotlightModerationApi';
    return { secret, url, ready: allowed && secret.length >= 32 };
}

async function callModeration(op, payload = {}, settings = moderationConfig()) {
    if (!settings.ready) throw Object.assign(new Error('Listing review is not configured yet.'), { status: 503, code: 'REVIEW_UNAVAILABLE' });
    const body = JSON.stringify({ ...payload, op });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', settings.secret).update(`${timestamp}.${body}`).digest('hex');
    const response = await fetch(settings.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spotlight-Timestamp': timestamp, 'X-Spotlight-Signature': signature },
        body, signal: AbortSignal.timeout(25000), redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok) {
        const safe = typeof data.error === 'string' && data.error.length < 300 ? data.error : 'Listing review is temporarily unavailable. Please try again.';
        throw Object.assign(new Error(safe), { status: response.status, code: typeof data.code === 'string' ? data.code : 'REVIEW_UNAVAILABLE' });
    }
    return data;
}

module.exports = { moderationConfig, callModeration };

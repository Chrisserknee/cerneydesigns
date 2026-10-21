'use strict';
const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');
const { bodyIsTooLarge, parseBody, sendJson } = require('../http');
const { config, sameOrigin } = require('../spotlight');
const ENDPOINT = 'https://us-west1-tip-line-8c2d7.cloudfunctions.net/spotlightLogoApi';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_INPUT_BYTES / 3) * 4;
const MAX_JSON_BYTES = MAX_BASE64 + 2048;

function logoConfig() {
    const secret = String(process.env.SPOTLIGHT_MODERATION_PROXY_SECRET || '');
    const live = process.env.VERCEL_ENV === 'production';
    const endpoint = live ? ENDPOINT.replace('spotlightLogoApi', 'cerneySelectsLogoApi') : ENDPOINT;
    return { secret, live, endpoint, ready: process.env.SPOTLIGHT_LOGO_URL === endpoint && secret.length >= 32 };
}

function createHandler({ getConfig = config, getProxyConfig = logoConfig, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    return async (request, response) => {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return sendJson(response, 405, { error: 'Choose a logo in the signup form.', code: 'UPLOAD_METHOD' }); }
        if (!sameOrigin(request, getConfig())) return sendJson(response, 403, { error: 'Request origin is not allowed.', code: 'UPLOAD_FORBIDDEN' });
        if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'JSON required.', code: 'UPLOAD_TYPE' });
        if (bodyIsTooLarge(request, MAX_JSON_BYTES)) return sendJson(response, 413, { error: 'Choose an image no larger than 2 MB.', code: 'LOGO_TOO_LARGE' });
        let body; try { body = parseBody(request); } catch { return sendJson(response, 400, { error: 'The image could not be read.', code: 'INVALID_LOGO' }); }
        if (typeof body?.imageBase64 === 'string' && body.imageBase64.length > MAX_BASE64) return sendJson(response, 413, { error: 'Choose an image no larger than 2 MB.', code: 'LOGO_TOO_LARGE' });
        if (!body || Array.isArray(body) || !['image/jpeg', 'image/png', 'image/webp'].includes(body.mimeType) || typeof body.imageBase64 !== 'string' || !body.imageBase64 || body.imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.imageBase64)) return sendJson(response, 400, { error: 'Choose a JPEG, PNG, or WebP image no larger than 2 MB.', code: 'INVALID_LOGO' });
        const proxy = getProxyConfig();
        // Vercel overwrites this header with the client's network address. Never
        // use a body-supplied identifier, and never store the raw IP in GCS.
        const clientIp = String(request.headers?.['x-vercel-forwarded-for'] || '').trim();
        if (!proxy.ready || !isIP(clientIp)) return sendJson(response, 503, { error: 'Logo upload is temporarily unavailable. Please try again.', code: 'UPLOAD_UNAVAILABLE' });
        const clientKey = createHmac('sha256', proxy.secret).update('spotlight-logo-client-v1:' + clientIp).digest('hex');
        const payload = JSON.stringify({ op: 'upload-logo', mimeType: body.mimeType, imageBase64: body.imageBase64, clientKey });
        const timestamp = String(now());
        const signature = createHmac('sha256', proxy.secret).update(timestamp + '.' + payload).digest('hex');
        try {
            const result = await fetchImpl(proxy.endpoint || ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spotlight-Timestamp': timestamp, 'X-Spotlight-Signature': signature }, body: payload, redirect: 'error', signal: AbortSignal.timeout(40000) });
            const data = await result.json();
            if (!result.ok) {
                const status = [400, 403, 413, 429].includes(result.status) ? result.status : 503;
                const code = ['INVALID_LOGO', 'LOGO_TOO_LARGE', 'UPLOAD_FORBIDDEN', 'UPLOAD_LIMIT', 'UPLOAD_CAPACITY'].includes(data.code) ? data.code : 'UPLOAD_UNAVAILABLE';
                if (status === 429) response.setHeader('Retry-After', '3600');
                return sendJson(response, status, { error: status === 503 ? 'Logo upload is temporarily unavailable. Please try again.' : String(data.error || 'The logo could not be uploaded.').slice(0, 200), code });
            }
            const logoUrl = new URL(data.logoUrl);
            if (logoUrl.origin !== 'https://firebasestorage.googleapis.com' || logoUrl.username || logoUrl.password || logoUrl.hash || !new RegExp('^/v0/b/tip-line-8c2d7\\.firebasestorage\\.app/o/_spotlight%2Fv1%2F' + (proxy.live ? 'live' : 'sandbox') + '%2Flogos%2F[a-f0-9]{48}\\.webp$').test(logoUrl.pathname) || logoUrl.searchParams.get('alt') !== 'media' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(logoUrl.searchParams.get('token') || '') || [...logoUrl.searchParams].length !== 2 || logoUrl.href.length > 500 || !Number.isSafeInteger(data.width) || !Number.isSafeInteger(data.height) || data.width < 1 || data.height < 1 || data.width > 512 || data.height > 512 || !Number.isSafeInteger(data.bytes) || data.bytes < 1 || data.bytes > 150 * 1024) throw new Error('Unexpected logo response');
            return sendJson(response, 200, { logoUrl: logoUrl.href, width: data.width, height: data.height, bytes: data.bytes });
        } catch { return sendJson(response, 503, { error: 'Logo upload is temporarily unavailable. Please try again.', code: 'UPLOAD_UNAVAILABLE' }); }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.MAX_JSON_BYTES = MAX_JSON_BYTES;
module.exports.logoConfig = logoConfig;

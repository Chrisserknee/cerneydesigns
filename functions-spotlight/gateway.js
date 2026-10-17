'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');

function gatewayAuthenticated(request, secret, now = Date.now()) {
    const timestamp = String(request.headers?.['x-spotlight-timestamp'] || '');
    const signature = String(request.headers?.['x-spotlight-signature'] || '');
    if (typeof secret !== 'string' || secret.length < 32 || !/^\d{13}$/.test(timestamp)
        || Math.abs(now - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)
        || !Buffer.isBuffer(request.rawBody)) return false;
    const expected = createHmac('sha256', secret).update(timestamp + '.').update(request.rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function createGateway({ getSecret, makeModeration, now = Date.now }) {
    return async (request, response) => {
        response.set('Cache-Control', 'private, no-store');
        response.set('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'POST') return response.status(405).json({ error: 'POST required.' });
        if (!Buffer.isBuffer(request.rawBody) || request.rawBody.length > 32768) return response.status(413).json({ error: 'Request is too large.' });
        if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return response.status(415).json({ error: 'JSON required.' });
        if (!gatewayAuthenticated(request, getSecret(), now())) return response.status(403).json({ error: 'Forbidden.' });
        let body;
        try { body = JSON.parse(request.rawBody.toString('utf8')); }
        catch { return response.status(400).json({ error: 'Invalid JSON.' }); }
        if (!body || Array.isArray(body) || !['ingest', 'review', 'decide', 'retry'].includes(body.op)) return response.status(400).json({ error: 'Unknown moderation operation.' });
        try {
            const moderation = makeModeration();
            let result;
            if (body.op === 'ingest') result = await moderation.ingest({ subscriptionId: body.subscriptionId });
            if (body.op === 'review') result = await moderation.review({ token: body.token });
            if (body.op === 'decide') result = await moderation.decide({ token: body.token, decision: body.decision, reason: body.reason, confirmed: body.confirmed === true });
            if (body.op === 'retry') result = await moderation.retry();
            return response.status(200).json(result || { ok: true });
        } catch (error) {
            const status = [400, 403, 404, 409, 503].includes(error.status) ? error.status : 503;
            const code = /^[A-Z_]{1,40}$/.test(error.code || '') ? error.code : 'RETRY_LATER';
            const messages = { 400: 'Check the submitted review details.', 403: 'This review link is invalid or expired.', 404: 'This application was not found.', 409: 'This application was already reviewed or changed. Refresh before continuing.', 503: 'The review service is temporarily unavailable. Please try again.' };
            // Never return raw provider errors, credentials, tokens or email bodies.
            console.error('Spotlight moderation request failed', { status, code });
            return response.status(status).json({ error: messages[status], code });
        }
    };
}

module.exports = { gatewayAuthenticated, createGateway };

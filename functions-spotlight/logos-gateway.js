'use strict';
const { gatewayAuthenticated } = require('./gateway');
const { MAX_JSON_BYTES } = require('./logos');

function createLogoGateway({ getSecret, makeLogos, now = Date.now }) {
    return async (request, response) => {
        response.set('Cache-Control', 'private, no-store');
        response.set('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'POST') return response.status(405).json({ error: 'POST required.', code: 'UPLOAD_METHOD' });
        if (!Buffer.isBuffer(request.rawBody) || request.rawBody.length > MAX_JSON_BYTES) return response.status(413).json({ error: 'Choose an image no larger than 2 MB.', code: 'LOGO_TOO_LARGE' });
        if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return response.status(415).json({ error: 'JSON required.', code: 'UPLOAD_TYPE' });
        if (!gatewayAuthenticated(request, getSecret(), now())) return response.status(403).json({ error: 'Forbidden.', code: 'UPLOAD_FORBIDDEN' });
        let body;
        try { body = JSON.parse(request.rawBody.toString('utf8')); } catch { return response.status(400).json({ error: 'Invalid upload.', code: 'INVALID_LOGO' }); }
        if (!body || Array.isArray(body) || body.op !== 'upload-logo') return response.status(400).json({ error: 'Invalid upload operation.', code: 'INVALID_LOGO' });
        try {
            return response.status(200).json(await makeLogos().upload({ imageBase64: body.imageBase64, mimeType: body.mimeType, clientKey: body.clientKey }));
        } catch (error) {
            const status = [400, 403, 413, 429].includes(error.status) ? error.status : 503;
            const allowed = ['INVALID_LOGO', 'LOGO_TOO_LARGE', 'UPLOAD_FORBIDDEN', 'UPLOAD_LIMIT', 'UPLOAD_CAPACITY'];
            const code = allowed.includes(error.code) ? error.code : 'UPLOAD_UNAVAILABLE';
            const message = status === 503 ? 'Logo upload is temporarily unavailable. Please try again.' : error.message;
            if (status === 429) response.set('Retry-After', '3600');
            return response.status(status).json({ error: message, code });
        }
    };
}
module.exports = { createLogoGateway };

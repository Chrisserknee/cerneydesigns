'use strict';

function sendJson(response, status, body, cacheControl = 'no-store') {
    response.setHeader('Cache-Control', cacheControl);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(status).json(body);
}

function parseBody(request) {
    if (Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString('utf8'));
    if (typeof request.body === 'string') return JSON.parse(request.body);
    return request.body;
}

function bodyIsTooLarge(request, maximumBytes = 16 * 1024) {
    const contentLength = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) return true;
    if (Buffer.isBuffer(request.body)) return request.body.length > maximumBytes;
    if (typeof request.body === 'string') return Buffer.byteLength(request.body, 'utf8') > maximumBytes;
    return false;
}

function isAllowedOrigin(request) {
    const origin = String(request.headers.origin || '').trim();
    if (!origin) return true;
    const siteUrl = String(process.env.SITE_URL || 'https://www.chriscerney.org').replace(/\/$/, '');
    try {
        return new URL(origin).origin === new URL(siteUrl).origin;
    } catch {
        return false;
    }
}

module.exports = {
    bodyIsTooLarge,
    isAllowedOrigin,
    parseBody,
    sendJson,
};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createLogoGateway } = require('./logos-gateway');
const { MAX_JSON_BYTES } = require('./logos');
const secret = 'logo-gateway-test-secret-with-more-than-32-characters', now = 1792228800000;
function request(body) { const rawBody = Buffer.from(JSON.stringify(body)), timestamp = String(now); return { method: 'POST', rawBody, headers: { 'content-type': 'application/json', 'x-spotlight-timestamp': timestamp, 'x-spotlight-signature': createHmac('sha256', secret).update(timestamp + '.').update(rawBody).digest('hex') } }; }
function response() { return { headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } }; }
const setup = upload => createLogoGateway({ getSecret: () => secret, now: () => now, makeLogos: () => ({ upload }) });

test('logo gateway rejects missing, stale and tampered signatures before storage work', async () => {
    let calls = 0;
    for (const change of [req => delete req.headers['x-spotlight-signature'], req => req.headers['x-spotlight-timestamp'] = String(now - 61000), req => req.rawBody = Buffer.from('{}')]) {
        const req = request({ op: 'upload-logo' }); change(req); const res = response(); await setup(async () => { calls++; })(req, res); assert.equal(res.statusCode, 403);
    }
    assert.equal(calls, 0);
});
test('logo gateway enforces POST, JSON, body cap and the single upload operation', async () => {
    const cases = [[Object.assign(request({}), { method: 'GET' }), 405], [Object.assign(request({}), { rawBody: Buffer.alloc(MAX_JSON_BYTES + 1) }), 413], [request({ op: 'decide' }), 400]];
    const plain = request({}); plain.headers['content-type'] = 'text/plain'; cases.push([plain, 415]);
    let calls = 0; for (const [req, expected] of cases) { const res = response(); await setup(async () => { calls++; })(req, res); assert.equal(res.statusCode, expected); } assert.equal(calls, 0);
});
test('logo gateway forwards only image and trusted client hash; it cannot call billing actions', async () => {
    let received; const res = response(); await setup(async input => { received = input; return { logoUrl: 'https://example.test/logo.webp' }; })(request({ op: 'upload-logo', imageBase64: 'YQ==', mimeType: 'image/png', clientKey: 'a'.repeat(64), token: 'review-token', decision: 'approve', path: '_sponsorships/private' }), res);
    assert.deepEqual(received, { imageBase64: 'YQ==', mimeType: 'image/png', clientKey: 'a'.repeat(64) }); assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('logo gateway exposes safe validation/quota codes and conceals storage error details', async () => {
    for (const [error, expected] of [[Object.assign(new Error('Upload limit reached.'), { status: 429, code: 'UPLOAD_LIMIT' }), 429], [new Error('private-service-secret'), 503]]) {
        const res = response(); await setup(async () => { throw error; })(request({ op: 'upload-logo' }), res); assert.equal(res.statusCode, expected); assert.doesNotMatch(JSON.stringify(res.body), /private-service-secret/); if (expected === 429) assert.equal(res.headers['Retry-After'], '3600');
    }
});

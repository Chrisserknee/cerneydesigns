'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createHandler, logoConfig, MAX_JSON_BYTES } = require('../api/_lib/spotlight-handlers/logo');
const siteUrl = 'https://preview.example.com', secret = 'logo-preview-test-secret-with-more-than-32-characters', now = 1792228800000;
const endpoint = 'https://us-west1-tip-line-8c2d7.cloudfunctions.net/spotlightLogoApi';
const valid = { logoUrl: 'https://firebasestorage.googleapis.com/v0/b/tip-line-8c2d7.firebasestorage.app/o/_spotlight%2Fv1%2Fsandbox%2Flogos%2F' + 'a'.repeat(48) + '.webp?alt=media&token=12345678-1234-4234-8234-123456789abc', width: 120, height: 80, bytes: 430 };
function response() { return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } }; }
function request(body = { imageBase64: 'YQ==', mimeType: 'image/png' }) { return { method: 'POST', body, headers: { origin: siteUrl, 'content-type': 'application/json', 'x-vercel-forwarded-for': '198.51.100.10' } }; }
const setup = (fetchImpl, overrides = {}) => createHandler({ getConfig: () => ({ siteUrl, enabled: false }), getProxyConfig: () => ({ ready: true, secret }), now: () => now, fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => valid })), ...overrides });
async function invoke(req, fetchImpl, overrides) { const res = response(); await setup(fetchImpl, overrides)(req, res); return res; }

test('upload rejects foreign/missing origins, cross-site requests and non-JSON before proxy work', async () => {
    let calls = 0;
    for (const mutate of [req => req.headers.origin = 'https://evil.example', req => delete req.headers.origin, req => req.headers['sec-fetch-site'] = 'cross-site', req => req.headers['content-type'] = 'text/plain', req => req.method = 'GET']) {
        const req = request(); mutate(req); const res = await invoke(req, async () => { calls++; }); assert.ok([403, 415, 405].includes(res.statusCode));
    }
    assert.equal(calls, 0);
});
test('body and base64 limits, invalid MIME and malformed JSON fail without contacting storage', async () => {
    const cases = [request({ imageBase64: 'a'.repeat(MAX_JSON_BYTES), mimeType: 'image/png' }), request({ imageBase64: 'YQ==', mimeType: 'image/svg+xml' }), request('{bad'), request({ imageBase64: 'data:image/png;base64,YQ==', mimeType: 'image/png' }), request({ imageBase64: 'A=', mimeType: 'image/png' })];
    const declared = request(); declared.headers['content-length'] = String(MAX_JSON_BYTES + 1); cases.push(declared);
    let calls = 0; for (const req of cases) { const res = await invoke(req, async () => { calls++; }); assert.ok([400, 413].includes(res.statusCode)); } assert.equal(calls, 0);
});
test('trusted deployment IP becomes an opaque HMAC client key, with only image fields sent to the fixed service', async () => {
    let captured; const req = request({ imageBase64: 'YQ==', mimeType: 'image/png', clientKey: 'spoof', endpoint: 'https://evil.example', filename: '../private' });
    const res = await invoke(req, async (url, options) => { captured = { url, options }; return { ok: true, json: async () => valid }; });
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, valid); assert.equal(captured.url, endpoint); assert.equal(captured.options.redirect, 'error'); assert.ok(captured.options.signal);
    const body = JSON.parse(captured.options.body); assert.deepEqual(Object.keys(body).sort(), ['clientKey', 'imageBase64', 'mimeType', 'op']);
    assert.equal(body.clientKey, createHmac('sha256', secret).update('spotlight-logo-client-v1:198.51.100.10').digest('hex'));
    assert.equal(captured.options.headers['X-Spotlight-Signature'], createHmac('sha256', secret).update(String(now) + '.' + captured.options.body).digest('hex'));
    assert.doesNotMatch(captured.options.body, /198\.51\.100\.10|spoof|private/); assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('only Vercel-provided valid IPs are accepted, including IPv6; body or X-Forwarded-For cannot bypass this', async () => {
    let calls = 0;
    for (const value of ['', '1.2.3.4, 5.6.7.8', 'not-ip']) { const req = request(); req.headers['x-vercel-forwarded-for'] = value; req.headers['x-forwarded-for'] = '198.51.100.20'; const res = await invoke(req, async () => { calls++; }); assert.equal(res.statusCode, 503); }
    assert.equal(calls, 0); const v6 = request(); v6.headers['x-vercel-forwarded-for'] = '2001:db8::1'; assert.equal((await invoke(v6)).statusCode, 200);
});
test('uploads work when checkout is disabled but fail closed when logo proxy is not configured', async () => {
    assert.equal((await invoke(request())).statusCode, 200);
    let calls = 0; const res = await invoke(request(), async () => { calls++; }, { getProxyConfig: () => ({ ready: false }) }); assert.equal(res.statusCode, 503); assert.equal(calls, 0);
});
test('only a sanitized Spotlight object URL and bounded image metadata are accepted', async () => {
    for (const data of [{ ...valid, logoUrl: 'https://evil.example/logo.webp' }, { ...valid, logoUrl: valid.logoUrl.replace('sandbox', 'production') }, { ...valid, logoUrl: valid.logoUrl + '&credential=secret' }, { ...valid, logoUrl: valid.logoUrl + '#fragment' }, { ...valid, logoUrl: valid.logoUrl.replace('https://', 'https://user:password@') }, { ...valid, width: 513 }, { ...valid, bytes: 153601 }, { ...valid, logoUrl: valid.logoUrl.replace('12345678-1234-4234-8234-123456789abc', 'invalid-token') }]) {
        const res = await invoke(request(), async () => ({ ok: true, json: async () => data })); assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /credential|password|fragment/);
    }
});
test('quota validation errors preserve retry information and network/provider internals remain hidden', async () => {
    const limited = await invoke(request(), async () => ({ ok: false, status: 429, json: async () => ({ code: 'UPLOAD_LIMIT', error: 'Upload limit reached.' }) })); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['Retry-After'], '3600'); assert.equal(limited.body.code, 'UPLOAD_LIMIT');
    for (const fetchImpl of [async () => { throw new Error('private-access-token'); }, async () => ({ ok: false, status: 500, json: async () => ({ error: 'private-access-token' }) })]) { const res = await invoke(request(), fetchImpl); assert.equal(res.statusCode, 503); assert.doesNotMatch(JSON.stringify(res.body), /private-access-token/); }
});
test('logo runtime is explicitly sandbox Preview/development with the fixed endpoint and strong shared secret', () => {
    const keys = ['VERCEL_ENV', 'SPOTLIGHT_LOGO_URL', 'SPOTLIGHT_MODERATION_PROXY_SECRET', 'SPOTLIGHT_ENABLED'], old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
        process.env.VERCEL_ENV = 'preview'; process.env.SPOTLIGHT_LOGO_URL = endpoint; process.env.SPOTLIGHT_MODERATION_PROXY_SECRET = secret; process.env.SPOTLIGHT_ENABLED = 'false'; assert.equal(logoConfig().ready, true);
        process.env.VERCEL_ENV = 'production'; assert.equal(logoConfig().ready, false); process.env.VERCEL_ENV = 'development'; assert.equal(logoConfig().ready, true);
        process.env.SPOTLIGHT_LOGO_URL = 'https://evil.example'; assert.equal(logoConfig().ready, false); process.env.SPOTLIGHT_LOGO_URL = endpoint; process.env.SPOTLIGHT_MODERATION_PROXY_SECRET = 'short'; assert.equal(logoConfig().ready, false);
    } finally { for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
});

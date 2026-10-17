'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createGateway } = require('./gateway');
const secret = 'dedicated-preview-proxy-test-secret-32-characters';
const now = 1792228800000;

function request(body, overrides = {}) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(now);
    return { method: 'POST', rawBody, headers: { 'content-type': 'application/json', 'x-spotlight-timestamp': timestamp, 'x-spotlight-signature': createHmac('sha256', secret).update(timestamp + '.').update(rawBody).digest('hex') }, ...overrides };
}

function response() {
    return { headers: {}, statusCode: 200, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
}

test('gateway rejects missing, stale and altered signatures before constructing providers', async () => {
    let created = 0;
    const handler = createGateway({ getSecret: () => secret, makeModeration: () => { created += 1; }, now: () => now });
    for (const mutate of [r => { delete r.headers['x-spotlight-signature']; }, r => { r.headers['x-spotlight-timestamp'] = String(now - 61000); }, r => { r.rawBody = Buffer.from('{"op":"retry"}'); }]) {
        const req = request({ op: 'review', token: 'private-token' }); mutate(req);
        const res = response(); await handler(req, res); assert.equal(res.statusCode, 403);
    }
    assert.equal(created, 0);
});

test('review only receives its token and decisions require an explicit boolean confirmation', async () => {
    const calls = [];
    const handler = createGateway({ getSecret: () => secret, makeModeration: () => ({ review: async value => { calls.push(['review', value]); return { status: 'pending' }; }, decide: async value => { calls.push(['decide', value]); return { status: 'pending' }; } }), now: () => now });
    let res = response(); await handler(request({ op: 'review', token: 'private-token', decision: 'approve', confirmed: true }), res);
    assert.equal(res.statusCode, 200); assert.deepEqual(calls[0], ['review', { token: 'private-token' }]);
    res = response(); await handler(request({ op: 'decide', token: 'private-token', decision: 'approve', confirmed: 'true' }), res);
    assert.equal(calls[1][1].confirmed, false);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('public requests, oversized bodies, invalid JSON and unknown operations never execute work', async () => {
    const handler = createGateway({ getSecret: () => secret, makeModeration: () => { throw new Error('should not execute'); }, now: () => now });
    const cases = [[request({ op: 'retry' }, { method: 'GET' }), 405], [request({}, { rawBody: Buffer.alloc(32769) }), 413], [request({ op: 'unknown' }), 400]];
    const invalid = request({}); invalid.rawBody = Buffer.from('not JSON'); invalid.headers['x-spotlight-signature'] = createHmac('sha256', secret).update(String(now) + '.').update(invalid.rawBody).digest('hex'); cases.push([invalid, 400]);
    for (const [req, expected] of cases) { const res = response(); await handler(req, res); assert.equal(res.statusCode, expected); }
});

test('unexpected errors return generic responses without provider bodies or capability tokens', async () => {
    const handler = createGateway({ getSecret: () => secret, makeModeration: () => ({ review: async () => { throw new Error('private-provider-error-token'); } }), now: () => now });
    const res = response(); await handler(request({ op: 'review', token: 'private-review-token' }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'RETRY_LATER');
    assert.ok(!JSON.stringify(res).includes('private-provider-error-token'));
    assert.ok(!JSON.stringify(res).includes('private-review-token'));
});

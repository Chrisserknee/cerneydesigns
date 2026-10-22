'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMemberExtras } = require('./member-extras');

function fixture() {
    let time = 1800000000000;
    const records = new Map(), sent = new Map(), calls = [];
    const controls = { ready: true, lostResponse: false, beforeSend: null };
    const store = {
        async read(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
        async create(id, value) { if (records.has(id)) return false; records.set(id, structuredClone(value)); return true; },
        async compareAndSwap(id, revision, value) { if (records.get(id)?.revision !== revision) return false; records.set(id, structuredClone(value)); return true; },
        async listDue({ now }) { return [...records.values()].filter(r => ['queued', 'leased'].includes(r.work.state) && r.work.nextAttemptAt <= now && r.work.leaseUntil <= now); },
    };
    const providers = {
        emailReady: () => controls.ready,
        async sendEmail(payload, key) {
            calls.push({ payload: structuredClone(payload), key });
            if (sent.has(key)) assert.deepEqual(sent.get(key).payload, payload);
            else sent.set(key, { id: `mail_${sent.size}`, payload: structuredClone(payload) });
            if (controls.beforeSend) { const fn = controls.beforeSend; controls.beforeSend = null; await fn(); }
            if (controls.lostResponse) { controls.lostResponse = false; throw new Error('Response lost after acceptance'); }
            return { id: sent.get(key).id };
        },
    };
    const service = createMemberExtras({ store, providers, settings: { siteUrl: 'https://preview.example.com', ownerEmail: 'owner@example.com' }, now: () => time });
    const input = { subscriptionId: 'sub_member', requestId: randomUUID(), offer: 'mustache', specialty: 'Plumber', area: 'Monterey', notes: 'A request\nwith two lines.', businessName: 'Sandbox business', email: 'member@example.com', consent: true };
    return { service, input, records, sent, calls, controls, advance: ms => { time += ms; } };
}

test('an enquiry persists and sends both truthful confirmations without billing operations', async () => {
    const f = fixture(); const result = await f.service.request(f.input);
    assert.equal(result.requests.length, 1); assert.equal(result.requests[0].status, 'requested');
    assert.equal(result.requests[0].emailStatus, 'sent'); assert.equal(f.sent.size, 2);
    assert.equal(f.calls[0].payload.to, 'owner@example.com'); assert.equal(f.calls[1].payload.to, 'member@example.com');
    assert.match(f.calls[1].payload.text, /not been charged/);
    assert.match(f.calls[0].payload.text, /no extra charge, upgrade, or exclusive reservation/);
    assert.equal(f.records.get('sub_member').work.state, 'idle');
    assert.ok(!JSON.stringify(result).includes('member@example.com'));
});

test('concurrent duplicate submits send one pair of emails; conflicting upgrades are rejected', async () => {
    const f = fixture();
    await Promise.all([f.service.request(f.input), f.service.request(f.input), f.service.request(f.input)]);
    assert.equal(f.sent.size, 2);
    assert.equal(Object.keys(f.records.get('sub_member').requests).length, 1);
    await assert.rejects(f.service.request({ ...f.input, requestId: randomUUID(), offer: 'featured' }), e => e.code === 'EXISTING_REQUEST');
    const retried = await f.service.request({ ...f.input, area: 'Salinas' });
    assert.equal(retried.requests[0].area, 'Monterey County');
});

test('ambiguous email failure retries the same payload and idempotency key', async () => {
    const f = fixture(); f.controls.lostResponse = true;
    const initial = await f.service.request(f.input); assert.equal(initial.requests[0].emailStatus, 'queued');
    f.advance(300001); await f.service.retry();
    assert.equal(f.sent.size, 2); assert.equal(f.calls[0].key, f.calls[1].key);
    assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
    assert.equal((await f.service.status(f.input)).requests[0].emailStatus, 'sent');
});

test('a second request queued during delivery is picked up without losing work', async () => {
    const f = fixture();
    f.controls.beforeSend = () => f.service.request({ ...f.input, requestId: randomUUID(), offer: 'spotlight', specialty: '', area: '' });
    await f.service.request(f.input); await f.service.retry();
    assert.equal(f.sent.size, 4); assert.equal(f.records.get('sub_member').work.state, 'idle');
});

test('disabled email retains jobs and an uncertain delivery past the dedupe window stops automatic resend', async () => {
    const f = fixture(); f.controls.ready = false; await f.service.request(f.input);
    assert.equal(f.sent.size, 0); assert.equal(f.records.get('sub_member').work.state, 'queued');
    f.controls.ready = true; f.controls.lostResponse = true; f.advance(300001); await f.service.retry();
    assert.equal(f.sent.size, 1);
    f.advance(24 * 3600000); await f.service.retry();
    assert.equal(f.records.get('sub_member').work.state, 'attention'); assert.equal(f.sent.size, 1);
});

test('invalid consent, request details, unknown offers and untrusted email strings create no records', async () => {
    for (const mutation of [{ consent: 'true' }, { offer: 'fake' }, { requestId: '../bad' }, { specialty: '' }, { notes: '<script>' }, { notes: 'x'.repeat(801) }, { email: 'someone@example.com\nBcc: other@example.com' }]) {
        const f = fixture(); await assert.rejects(f.service.request({ ...f.input, ...mutation }));
        assert.equal(f.records.size, 0); assert.equal(f.sent.size, 0);
    }
});

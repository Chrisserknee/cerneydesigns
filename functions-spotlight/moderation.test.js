'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModeration } = require('./moderation');
const { profileHash } = require('./providers');
const { buildEmail } = require('./emails');
const PROFILE = { businessName: 'Sandbox Coffee', category: 'Food & drink', city: 'Monterey', description: 'A synthetic test business.', website: 'https://example.com/', phone: '', logoUrl: '' };
function fixture() {
    let time = 1800000000000;
    const data = new Map(); const calls = { inspect: 0, hold: 0, approve: 0, cancel: 0, refund: 0, sends: [] };
    const controls = { emailReady: true, refundStatus: 'succeeded', refundExtra: {}, errors: {}, beforeCas: null, beforeSend: null };
    const store = {
        async read(id) { return data.has(id) ? structuredClone(data.get(id)) : null; },
        async create(id, record) { if (data.has(id)) return false; data.set(id, structuredClone(record)); return true; },
        async compareAndSwap(id, revision, record) {
            if (controls.beforeCas) { const fn = controls.beforeCas; controls.beforeCas = null; await fn(); }
            if (data.get(id)?.revision !== revision) return false;
            data.set(id, structuredClone(record)); return true;
        },
        async listDue({ now, limit }) { return [...data.values()].filter((record) => ['queued', 'leased'].includes(record.work.state) && record.work.nextAttemptAt <= now && record.work.leaseUntil <= now).slice(0, limit).map((record) => structuredClone(record)); },
    };
    const snapshot = { subscriptionId: 'sub_test', customerId: 'cus_test', initialInvoiceId: 'in_initial', paymentIntentId: 'pi_initial', profile: PROFILE, profileHash: profileHash(PROFILE), customerEmail: 'delivered@resend.dev', paidAmount: 10000, currency: 'usd', paidAt: time, periodEnd: time + 30 * 86400000 };
    function maybeError(operation) { if (controls.errors[operation]) { const error = controls.errors[operation]; delete controls.errors[operation]; throw error; } }
    const sent = new Map();
    const providers = {
        async inspectInitial() { calls.inspect++; maybeError('inspect'); return structuredClone(snapshot); },
        async hold() { calls.hold++; maybeError('hold'); },
        async approve() { calls.approve++; maybeError('approve'); },
        async cancel() { calls.cancel++; maybeError('cancel'); },
        async refund() { calls.refund++; maybeError('refund'); return { status: controls.refundStatus, refundId: 're_test', refundedAmount: controls.refundStatus === 'succeeded' ? 10000 : 0, ...controls.refundExtra }; },
        emailReady: () => controls.emailReady,
        emailIdempotencyWindowMs: 23 * 3600000,
        async sendEmail(payload, key) { calls.sends.push({ payload: structuredClone(payload), key }); if (!sent.has(key)) sent.set(key, { id: `mail_${sent.size}` }); if (controls.beforeSend) { const callback = controls.beforeSend; controls.beforeSend = null; await callback(); } maybeError('send'); return sent.get(key); },
    };
    const settings = { siteUrl: 'https://preview.vercel.app', reviewSecret: 'test-review-secret-with-at-least-32-characters', reviewWithinMs: 2 * 86400000, retryMs: 300000 };
    const core = createModeration({ store, providers, settings, now: () => time });
    const token = () => {
        const email = calls.sends.find((call) => call.key.endsWith(':owner-review'));
        const link = email.payload.text.match(/https:\/\/preview\.vercel\.app\/spotlightreview\/#[^\s]+/)[0];
        return new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    };
    return { core, data, calls, controls, store, providers, settings, snapshot, token, sent, advance: (ms) => { time += ms; }, now: () => time };
}
async function application(f) { await f.core.ingest({ subscriptionId: 'sub_test' }); return f.token(); }

test('paid ingestion pins receipt/profile, holds billing, and creates durable owner/applicant mail once', async () => {
    const f = fixture(); const token = await application(f);
    const result = await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(result.status, 'pending'); assert.equal(result.decisionAllowed, true);
    assert.equal(f.calls.inspect, 1); assert.equal(f.calls.hold, 1); assert.equal(f.sent.size, 2);
    assert.equal(f.data.get('sub_test').snapshot.initialInvoiceId, 'in_initial');
    assert.equal(f.data.get('sub_test').snapshot.paymentIntentId, 'pi_initial');
    assert.equal((await f.core.review({ token })).business.businessName, PROFILE.businessName);
    assert.ok(f.calls.sends.every((call) => call.payload.subject.includes('SANDBOX TEST')));
});

test('review/scanner GET is read-only and token is scoped, tamper-proof and expiring', async () => {
    const f = fixture(); const token = await application(f);
    const before = structuredClone(f.data.get('sub_test'));
    await f.core.review({ token }); await f.core.review({ token });
    assert.deepEqual(f.data.get('sub_test'), before);
    await assert.rejects(f.core.review({ token: token.slice(0, -2) + 'xx' }), { status: 403 });
    const [payload, signature] = token.split('.'); const decoded = JSON.parse(Buffer.from(payload, 'base64url')); decoded.sub = 'sub_other';
    await assert.rejects(f.core.review({ token: `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}` }), { status: 403 });
    await assert.rejects(f.core.decide({ token, decision: 'approve' }), { status: 400 });
    f.advance(7 * 86400000 + 1);
    await assert.rejects(f.core.review({ token }), { status: 403 });
    assert.equal(f.calls.approve, 0); assert.equal(f.calls.cancel, 0);
});

test('simultaneous approve/decline has exactly one durable winning decision', async () => {
    const f = fixture(); const token = await application(f);
    const results = await Promise.allSettled([
        f.core.decide({ token, decision: 'approve', confirmed: true }),
        f.core.decide({ token, decision: 'decline', reason: 'Outside the service area.', confirmed: true }),
    ]);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'DECISION_CONFLICT');
    assert.equal(f.calls.approve + f.calls.cancel, 1);
    const record = f.data.get('sub_test');
    assert.equal(record.decision.value, 'approve'); assert.equal(record.status, 'approved');
    assert.equal(f.calls.refund, 0);
});

test('decline requires a reason; successful decline cancels before refund and sends truthful final mail', async () => {
    const f = fixture(); const token = await application(f);
    await assert.rejects(f.core.decide({ token, decision: 'decline', reason: '', confirmed: true }), { status: 400 });
    await assert.rejects(f.core.decide({ token, decision: 'decline', reason: 'a'.repeat(501), confirmed: true }), { status: 400 });
    f.providers.refund = async () => { assert.equal(f.data.get('sub_test').effects.canceled, true); f.calls.refund++; return { status: 'succeeded', refundId: 're_test', refundedAmount: 10000 }; };
    const result = await f.core.decide({ token, decision: 'decline', reason: 'Not a fit.\nThank you.', confirmed: true });
    assert.equal(result.status, 'declined'); assert.equal(result.refundStatus, 'succeeded'); assert.equal(result.reason, 'Not a fit. Thank you.');
    const message = f.calls.sends.find((call) => call.key.endsWith(':applicant-declined'));
    assert.match(message.payload.text, /confirmed a full \$100 refund/);
    await f.core.decide({ token, decision: 'decline', reason: result.reason, confirmed: true });
    assert.equal(f.calls.cancel, 1); assert.equal(f.calls.refund, 1);
});

test('cancellation failure is durable and prevents any refund or decline email until retry succeeds', async () => {
    const f = fixture(); const token = await application(f); f.controls.errors.cancel = new Error('network');
    const result = await f.core.decide({ token, decision: 'decline', reason: 'Not eligible.', confirmed: true });
    assert.equal(result.status, 'declining'); assert.equal(f.calls.refund, 0);
    assert.equal(f.calls.sends.filter((call) => call.key.includes('declin')).length, 0);
    f.advance(300001); await f.core.retry();
    assert.equal(f.data.get('sub_test').status, 'declined'); assert.equal(f.calls.cancel, 2); assert.equal(f.calls.refund, 1);
});

test('pending and failed refunds never claim a successful refund; webhook/retry reconciles success', async () => {
    const f = fixture(); const token = await application(f); f.controls.refundStatus = 'pending';
    const pending = await f.core.decide({ token, decision: 'decline', reason: 'Not eligible.', confirmed: true });
    assert.equal(pending.status, 'declining'); assert.equal(pending.refundStatus, 'pending');
    assert.ok(!f.calls.sends.some((call) => call.key.endsWith(':applicant-declined')));
    assert.match(f.calls.sends.find((call) => call.key.endsWith(':applicant-declining')).payload.text, /refund is being arranged/);
    f.controls.refundStatus = 'failed'; f.advance(300001); await f.core.retry();
    assert.equal(f.data.get('sub_test').refund.status, 'failed'); assert.equal(f.data.get('sub_test').status, 'declining');
    f.controls.refundStatus = 'succeeded'; await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(f.data.get('sub_test').status, 'declined');
    assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':applicant-declining')).length, 1);
});

test('refund network failure persists decision and retries without reconfirming or recanceling', async () => {
    const f = fixture(); const token = await application(f); f.controls.errors.refund = new Error('lost response');
    await f.core.decide({ token, decision: 'decline', reason: 'Not eligible.', confirmed: true });
    f.advance(300001); await f.core.retry();
    assert.equal(f.calls.cancel, 1); assert.equal(f.calls.refund, 2); assert.equal(f.data.get('sub_test').status, 'declined');
});

test('Resend uncertain delivery reuses exact payload/key and does not duplicate accepted mail', async () => {
    const f = fixture(); f.controls.errors.send = new Error('response lost after acceptance');
    await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(f.sent.size, 1);
    f.advance(300001); await f.core.retry();
    assert.deepEqual(f.calls.sends[0], f.calls.sends[1]); assert.equal(f.sent.size, 2);
});

test('unknown email result beyond retention window stops automatic resending', async () => {
    const f = fixture(); f.controls.errors.send = new Error('unknown result');
    await f.core.ingest({ subscriptionId: 'sub_test' });
    f.advance(24 * 3600000); await f.core.retry();
    assert.equal(f.data.get('sub_test').status, 'needs_attention'); assert.equal(f.calls.sends.length, 1);
    f.advance(300001); await f.core.retry();
    assert.equal(f.data.get('sub_test').work.state, 'attention'); assert.equal(f.calls.sends.length, 2);
    assert.ok(f.calls.sends[1].key.endsWith(':owner-attention'));
});

test('disabled email retains unattempted durable jobs for later delivery', async () => {
    const f = fixture(); f.controls.emailReady = false;
    await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(f.calls.hold, 1); assert.deepEqual(f.data.get('sub_test').emails, {});
    f.advance(2 * 86400000); f.controls.emailReady = true; await f.core.retry();
    assert.equal(f.sent.size, 3); assert.equal(f.data.get('sub_test').work.state, 'queued');
});

test('expired worker lease is reclaimed, active lease prevents duplicate workers', async () => {
    const f = fixture(); f.controls.emailReady = false; await f.core.ingest({ subscriptionId: 'sub_test' });
    const record = f.data.get('sub_test'); record.work = { state: 'leased', nextAttemptAt: f.now(), leaseOwner: 'crashed-worker', leaseUntil: f.now() + 10000, attempts: 1 }; f.data.set(record.id, record);
    f.controls.emailReady = true; await f.core.retry(); assert.equal(f.sent.size, 0);
    f.advance(10001); await Promise.all([f.core.retry(), f.core.retry()]); assert.equal(f.sent.size, 2);
});

test('profile mismatch on approval is held for attention and never published or emailed approved', async () => {
    const f = fixture(); const token = await application(f);
    f.controls.errors.approve = Object.assign(new Error('changed profile'), { status: 409, code: 'PROFILE_CHANGED' });
    const result = await f.core.decide({ token, decision: 'approve', confirmed: true });
    assert.equal(result.status, 'needs_attention'); assert.equal(f.data.get('sub_test').effects.approved, false);
    assert.ok(!f.calls.sends.some((call) => call.key.endsWith(':applicant-approved')));
});

test('a provider cannot falsely complete a partial successful refund', async () => {
    const f = fixture(); const token = await application(f);
    f.providers.refund = async () => ({ status: 'succeeded', refundedAmount: 5000 });
    const result = await f.core.decide({ token, decision: 'decline', reason: 'Not eligible.', confirmed: true });
    assert.equal(result.status, 'needs_attention');
    assert.ok(!f.calls.sends.some((call) => call.key.endsWith(':applicant-declined')));
});

test('foreign/unpaid/canceled events without an application are acknowledged without emails', async () => {
    const f = fixture(); f.providers.inspectInitial = async () => null;
    assert.deepEqual(await f.core.ingest({ subscriptionId: 'sub_unpaid' }), { ignored: true, reviewStatus: 'not_applicable' });
    assert.equal(f.data.size, 0); assert.equal(f.sent.size, 0);
});

test('email review actions are fragment links and never directly perform a decision', () => {
    const f = fixture();
    const message = buildEmail({ snapshot: f.snapshot, reason: '' }, 'owner-review', f.settings, 'payload.signature');
    const links = [...message.text.matchAll(/https:\/\/preview\.vercel\.app\/spotlightreview\/#[^\s]+/g)].map((match) => new URL(match[0]));
    assert.equal(links.length, 2); assert.ok(links.every((link) => link.search === '' && link.hash.includes('token=payload.signature')));
    assert.match(message.text, /must confirm/);
});

test('the two-day review deadline starts at payment, and overdue never means automatic approval', async () => {
    const f = fixture(); f.snapshot.paidAt -= 86400000;
    const result = await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(result.reviewDueAt, f.now() + 86400000);
    f.advance(86400001); await f.core.retry();
    assert.equal(f.data.get('sub_test').status, 'pending');
    assert.equal(f.calls.approve, 0); assert.equal(f.calls.cancel, 0);
    assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':owner-overdue')).length, 1);
});

test('a decision during the active ingestion lease is applied once by its existing worker', async () => {
    for (const decision of ['approve', 'decline']) {
        const f = fixture();
        f.controls.beforeSend = async () => { await f.core.decide({ token: f.token(), decision, reason: decision === 'decline' ? 'Not eligible.' : '', confirmed: true }); };
        const result = await f.core.ingest({ subscriptionId: 'sub_test' });
        assert.equal(result.status, decision === 'approve' ? 'approved' : 'declined');
        assert.equal(f.calls.approve + f.calls.cancel, 1);
        assert.equal(f.data.get('sub_test').work.state, 'idle');
    }
});

test('a failed hold alerts the owner durably and never claims applicant approval or refund', async () => {
    const f = fixture(); f.controls.errors.hold = Object.assign(new Error('permission denied'), { statusCode: 403, code: 'more_permissions_required' });
    const result = await f.core.ingest({ subscriptionId: 'sub_test' });
    assert.equal(result.status, 'needs_attention'); assert.equal(result.decisionAllowed, false);
    assert.equal(f.calls.sends.length, 0);
    f.advance(300001); f.controls.errors.send = new Error('response lost'); await f.core.retry();
    f.advance(300001); await f.core.retry();
    assert.equal(f.calls.hold, 1); assert.equal(f.calls.approve, 0); assert.equal(f.calls.cancel, 0); assert.equal(f.calls.refund, 0);
    assert.equal(f.sent.size, 1);
    assert.ok(f.calls.sends.every((call) => call.key.endsWith(':owner-attention')));
    assert.deepEqual(f.calls.sends[0], f.calls.sends[1]);
    assert.match(f.calls.sends[0].payload.text, /Billing hold: Not confirmed/);
    assert.match(f.calls.sends[0].payload.text, /more_permissions_required/);
    assert.equal(f.data.get('sub_test').work.state, 'attention');
});

test('attention after successful approval does not claim the listing is hidden or repeat approval', async () => {
    const f = fixture(); const token = await application(f); f.controls.errors.send = new Error('response lost');
    await f.core.decide({ token, decision: 'approve', confirmed: true });
    assert.equal(f.data.get('sub_test').effects.approved, true);
    f.advance(24 * 3600000); await f.core.retry();
    f.advance(300001); await f.core.retry();
    const alert = f.calls.sends.find((call) => call.key.endsWith(':owner-attention'));
    assert.match(alert.payload.text, /Listing approval: Confirmed/);
    assert.match(alert.payload.text, /Publication or billing may already have changed/);
    assert.equal(f.calls.approve, 1);
});

test('a pending review receives one replacement token, invalidates the old link, then alerts on second expiry', async () => {
    const f = fixture(); const original = await application(f);
    f.advance(2 * 86400000); await f.core.retry();
    f.advance(5 * 86400000 + 1); await f.core.retry();
    const email = f.calls.sends.find((call) => call.key.endsWith(':owner-review-renewed'));
    const link = email.payload.text.match(/https:\/\/preview\.vercel\.app\/spotlightreview\/#[^\s]+/)[0];
    const replacement = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    await assert.rejects(f.core.review({ token: original }), { status: 403 });
    assert.equal((await f.core.review({ token: replacement })).status, 'pending');
    assert.equal(f.data.get('sub_test').tokenRenewals, 1);
    f.advance(7 * 86400000 + 1); await f.core.retry();
    assert.equal(f.data.get('sub_test').status, 'needs_attention');
    f.advance(300001); await f.core.retry();
    assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':owner-review-renewed')).length, 1);
    assert.match(f.calls.sends.find((call) => call.key.endsWith(':owner-attention')).payload.text, /REVIEW_EXPIRED/);
    assert.equal(f.calls.approve, 0); assert.equal(f.calls.refund, 0);
});

test('action-required and repeatedly failed refunds alert once while reconciliation remains possible', async () => {
    for (const extra of [{ requiresAction: true }, { manualRequired: true }]) {
        const f = fixture(); const token = await application(f); f.controls.refundStatus = extra.requiresAction ? 'pending' : 'failed'; f.controls.refundExtra = extra;
        const result = await f.core.decide({ token, decision: 'decline', reason: 'Not eligible.', confirmed: true });
        assert.equal(result.status, 'declining'); assert.equal(result.refundNeedsAttention, true);
        assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':owner-refund-attention')).length, 1);
        assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':applicant-declined')).length, 0);
        f.advance(300001); await f.core.retry();
        assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':owner-refund-attention')).length, 1);
        f.controls.refundStatus = 'succeeded'; f.controls.refundExtra = {};
        const settled = await f.core.ingest({ subscriptionId: 'sub_test' });
        assert.equal(settled.status, 'declined'); assert.equal(settled.refundNeedsAttention, false);
        assert.equal(f.calls.cancel, 1);
        assert.equal(f.calls.sends.filter((call) => call.key.endsWith(':applicant-declined')).length, 1);
    }
});


test('live confirmation emails use the real brand and new domain without a test subject', () => {
    const f = fixture();
    const settings = { ...f.settings, live: true, siteUrl: 'https://cerneyselects.com' };
    const received = buildEmail({ snapshot: f.snapshot }, 'applicant-received', settings, '');
    const approved = buildEmail({ snapshot: f.snapshot }, 'applicant-approved', settings, '');
    assert.equal(received.subject, 'Your CerneySelects application is in');
    assert.match(received.from, /^CerneySelects </);
    assert.match(approved.text, /https:\/\/cerneyselects.com\/apply\/#manage/);
    assert.doesNotMatch(approved.text, /chriscerney.org|spotlightsignup/);
});

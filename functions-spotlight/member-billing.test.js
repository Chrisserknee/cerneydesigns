'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMemberBilling, canonicalSpecialty } = require('./member-billing');

function memoryStore() {
    const records = new Map();
    return { records, async read(id) { return structuredClone(records.get(id) || null); }, async create(id, r) { if (records.has(id)) return false; records.set(id, structuredClone(r)); return true; }, async compareAndSwap(id, revision, r) { if (records.get(id)?.revision !== revision) return false; records.set(id, structuredClone(r)); return true; }, async listAll() { return [...records.values()].map(r => structuredClone(r)); } };
}
async function fixture(offer = 'featured', shared) {
    const store = shared?.store || memoryStore(), slots = shared?.slots || memoryStore();
    let time = 1800000000000;
    const base = `sub_${randomUUID().replaceAll('-', '')}`, requestId = randomUUID(), calls = [], sessions = new Map();
    const controls = { paid: true, continuing: true, state: 'active', cancelAt: null, lostCheckout: false };
    const settings = { reviewSecret: 's'.repeat(40), siteUrl: 'https://example.com', ownerEmail: 'owner@example.com', billingEnabled: true };
    const payments = {
        async base() { return { paid: controls.paid, continuing: controls.continuing }; },
        async checkout(id, request) {
            calls.push('checkout');
            if (!sessions.has(request.id)) sessions.set(request.id, { id: `cs_test_${sessions.size}session`, url: 'https://checkout.stripe.com/c/pay/example' });
            if (controls.lostCheckout) { controls.lostCheckout = false; throw Error('Response lost'); }
            return sessions.get(request.id);
        },
        async inspect() { return { state: controls.state, member: { paid: controls.paid, continuing: controls.continuing }, ...(offer === 'spotlight' ? {} : { subscription: { id: 'sub_addon' }, subscriptionId: 'sub_addon', periodEnd: time / 1000 + 3000000, cancelAt: controls.cancelAt }) }; },
        async minimum() { calls.push('minimum'); return { scheduleId: 'sub_sched', minimumEnd: time / 1000 + 9000000 }; },
        async cancel() { calls.push('cancel'); controls.cancelAt = time / 1000 + 3000000; },
    };
    const service = createMemberBilling({ store, slots, payments, settings, now: () => time });
    const request = { id: requestId, offer, specialty: 'Plumber', notes: 'Example request' };
    const link = service.prepare(base, request, { businessName: 'Example', email: 'member@example.com' });
    await store.create(base, { id: base, revision: 0, requests: { [requestId]: request }, emails: {}, work: { state: 'idle', leaseUntil: 0 } });
    const token = new URL(link).hash.slice(1);
    const approve = extra => service.quote({ token, decision: 'approve', decisionId: randomUUID(), specialty: 'Plumber', scope: 'Two-minute social video and Instagram collaboration.', amount: 125000, confirmed: true, ...extra });
    const checkout = async extra => { const r = (await store.read(base)).requests[requestId]; return service.checkout({ subscriptionId: base, requestId, version: r.quote?.version, consent: true, ...extra }); };
    return { service, settings, store, slots, payments, controls, calls, sessions, base, requestId, token, approve, checkout, advance: ms => { time += ms; } };
}

test('request and approved quote never charge; client price and county cannot override fixed featured terms', async () => {
    const f = await fixture(); const quote = await f.approve({ amount: 1, area: 'Salinas', minimumMonths: 12 });
    assert.equal(quote.quote.amount, 15000); assert.equal(quote.quote.minimumMonths, 0); assert.equal(quote.quote.area, 'Monterey County');
    assert.deepEqual(f.calls, []); assert.equal((await f.slots.listAll()).length, 0);
    assert.equal(Object.keys((await f.store.read(f.base)).emails).length, 1);
});
test('forged, expired and wrong-scope review tokens cannot approve a quote', async () => {
    const f = await fixture();
    await assert.rejects(f.service.review({ token: `${f.token}x` }), e => e.code === 'INVALID_TOKEN');
    f.advance(31 * 86400000); await assert.rejects(f.approve(), e => e.code === 'INVALID_TOKEN');
    assert.equal(Object.keys((await f.store.read(f.base)).emails).length, 0);
});
test('quote retry is idempotent and reused decision cannot alter price or scope', async () => {
    const f = await fixture('spotlight'); const decisionId = randomUUID();
    const one = await f.approve({ decisionId }); const two = await f.approve({ decisionId });
    assert.deepEqual(one, two); assert.equal(Object.keys((await f.store.read(f.base)).emails).length, 1);
    await assert.rejects(f.approve({ decisionId, amount: 200000 }), e => e.code === 'ALREADY_STARTED');
});
test('unapproved, expired, changed, disabled and unpaid checkout cannot reach Stripe', async () => {
    const f = await fixture(); await assert.rejects(f.checkout()); await f.approve();
    await assert.rejects(f.checkout({ consent: false })); await assert.rejects(f.checkout({ version: randomUUID() }));
    f.settings.billingEnabled = false; await assert.rejects(f.checkout(), e => e.code === 'BILLING_DISABLED');
    f.settings.billingEnabled = true; f.controls.continuing = false; await assert.rejects(f.checkout(), e => e.code === 'PAID_MEMBER_REQUIRED');
    f.controls.continuing = true; f.advance(8 * 86400000); await assert.rejects(f.checkout(), e => e.code === 'QUOTE_EXPIRED');
    assert.deepEqual(f.calls, []);
});
test('simultaneous competing members can reserve only one countywide specialty', async () => {
    const a = await fixture(), b = await fixture('featured', a);
    await a.approve(); await b.approve({ specialty: 'PLUMBER' });
    const results = await Promise.allSettled([a.checkout(), b.checkout()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SPECIALTY_UNAVAILABLE');
    assert.equal(a.sessions.size + b.sessions.size, 1);
});
test('lost checkout response retains reservation and retries the identical payment attempt', async () => {
    const f = await fixture(); await f.approve(); f.controls.lostCheckout = true;
    await assert.rejects(f.checkout()); assert.equal(f.sessions.size, 1);
    const before = (await f.store.read(f.base)).requests[f.requestId].billing;
    await f.checkout(); assert.equal(f.sessions.size, 1);
    const after = (await f.store.read(f.base)).requests[f.requestId].billing;
    assert.equal(before.startedAt, after.startedAt); assert.equal(before.expiresAt, after.expiresAt);
    assert.equal((await f.slots.listAll())[0].state, 'reserved');
});
test('only canonical paid state activates specialty; refund removes it and cancels future renewals', async () => {
    const f = await fixture(); await f.approve(); await f.checkout();
    f.controls.state = 'processing'; assert.equal(await f.service.entitlement({ subscriptionId: f.base }), null);
    f.controls.state = 'active'; assert.equal((await f.service.entitlement({ subscriptionId: f.base })).specialty, 'Plumber');
    assert.equal(Object.keys((await f.store.read(f.base)).emails).length, 3);
    await f.service.reconcile(f.base, f.requestId); assert.equal(Object.keys((await f.store.read(f.base)).emails).length, 3);
    f.controls.state = 'payment_review'; assert.equal(await f.service.entitlement({ subscriptionId: f.base }), null); assert.ok(f.calls.includes('cancel'));
});
test('cancellation remains available to a lapsed member and repeated events retain one confirmation', async () => {
    const f = await fixture(); await f.approve(); await f.checkout(); await f.service.reconcile(f.base, f.requestId);
    f.controls.paid = false; f.controls.continuing = false;
    const payload = { subscriptionId: f.base, requestId: f.requestId, confirmed: true };
    await f.service.cancel(payload); await f.service.cancel(payload);
    const r = (await f.store.read(f.base)).requests[f.requestId]; assert.equal(r.billing.cancellationRequested, true); assert.ok(r.billing.cancelAt);
    assert.equal(Object.keys((await f.store.read(f.base)).emails).filter(k => k.includes(':cancel-')).length, 1);
    assert.equal(await f.service.entitlement({ subscriptionId: f.base }), null);
});
test('Mustache minimum is attached once; featured-only never uses a commitment schedule', async () => {
    const f = await fixture('mustache'); const quote = await f.approve();
    assert.equal(quote.quote.minimumMonths, 3); assert.equal(quote.quote.setup, 50000);
    await f.checkout(); await f.service.reconcile(f.base, f.requestId); await f.service.reconcile(f.base, f.requestId);
    assert.equal(f.calls.filter(x => x === 'minimum').length, 1);
    const plain = await fixture(); await plain.approve(); await plain.checkout(); await plain.service.reconcile(plain.base, plain.requestId);
    assert.equal(plain.calls.includes('minimum'), false);
});
test('expired unpaid checkout releases its specialty; completed paid video never reserves one', async () => {
    const f = await fixture(); await f.approve(); await f.checkout(); f.controls.state = 'expired';
    await f.service.reconcile(f.base, f.requestId); assert.equal((await f.slots.listAll())[0].owner, '');
    const video = await fixture('spotlight'); await assert.rejects(video.approve({ amount: 99999 })); await video.approve(); await video.checkout();
    video.controls.state = 'paid'; await video.service.reconcile(video.base, video.requestId);
    assert.equal((await video.slots.listAll()).length, 0); assert.equal((await video.service.orders({ subscriptionId: video.base })).orders[0].billing.state, 'paid');
});
test('uncertain checkout older than idempotency window does not create a second payment', async () => {
    const f = await fixture(); await f.approve(); f.controls.lostCheckout = true; await assert.rejects(f.checkout());
    f.advance(24 * 3600000); const count = f.calls.length;
    await assert.rejects(f.checkout(), e => e.code === 'CHECKOUT_ATTENTION'); await f.service.retry();
    assert.equal(f.calls.length, count); assert.equal((await f.store.read(f.base)).requests[f.requestId].billing.attention, true);
});
test('canonical specialties collapse spelling case, spacing and punctuation', () => {
    assert.equal(canonicalSpecialty(' Plumbing & Heating '), canonicalSpecialty('PLUMBING-HEATING'));
});
test('late expired-checkout reconciliation cannot overwrite a replacement quote', async () => {
    const f = await fixture(); await f.approve(); await f.checkout();
    f.controls.state = 'expired'; await f.service.reconcile(f.base, f.requestId);
    const inspect = f.payments.inspect;
    let replacement;
    f.payments.inspect = async () => { replacement = await f.approve({ specialty: 'Electrician' }); return inspect(); };
    await f.service.reconcile(f.base, f.requestId);
    const current = (await f.store.read(f.base)).requests[f.requestId];
    assert.equal(current.quote.version, replacement.quote.version); assert.equal(current.billing, undefined);
});
test('payment review stops collection even when a later cancellation was already scheduled', async () => {
    const f = await fixture('mustache'); await f.approve(); await f.checkout(); await f.service.reconcile(f.base, f.requestId);
    f.controls.cancelAt = 1900000000; f.controls.state = 'payment_review';
    await f.service.reconcile(f.base, f.requestId);
    assert.ok(f.calls.includes('cancel'));
    const emails = Object.keys((await f.store.read(f.base)).emails);
    assert.equal(emails.filter(key => key.includes('payment-review')).length, 2);
});

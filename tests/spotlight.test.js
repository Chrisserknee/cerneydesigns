'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');
const Stripe = require('stripe');
const { createHandler } = require('../api/spotlight');
const { createHandler: createWebhookHandler } = require('../api/spotlight-webhook');
const { MARKER, COOKIE_NAME, PRICE, createService, config, profileMetadata, publicProfileHash, published, setOwnerCookie, ownerSessionId, validPaidSubscription, validateProfile } = require('../api/_lib/spotlight');

const settings = {
    secret: 'sk_test_spotlight', signingSecret: 'testing-only-secret-value-with-more-than-32-characters',
    priceId: 'price_spotlight', webhookSecret: 'whsec_local_spotlight_test', portalConfigurationId: 'bpc_spotlight',
    siteUrl: 'https://www.chriscerney.org', portalLoginUrl: 'https://billing.stripe.com/p/login/test', enabled: true, live: false,
};
const profile = { businessName: 'Coast Coffee', category: 'Food & drink', city: 'Monterey', description: 'Coffee and pastries by the coast.', website: 'https://example.com/', logoUrl: '', phone: '+1 (831) 555-0100', email: 'owner@example.com' };
function price() { return { id: settings.priceId, active: true, currency: 'usd', unit_amount: 10000, type: 'recurring', billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, livemode: false }; }
function subscription(invoiceId = 'in_current') {
    const start = Math.floor(Date.now() / 1000) - 3600;
    const end = start + 30 * 86400;
    return {
        id: 'sub_business', livemode: false, status: 'active', customer: 'cus_owner', cancel_at_period_end: false,
        metadata: { spotlight: MARKER, owner_key: 'owner_key', ...profileMetadata(profile), spotlight_review_status: 'approved', spotlight_approved_profile: publicProfileHash(profile) },
        items: { has_more: false, data: [{ id: 'si_business', quantity: 1, price: price(), current_period_start: start, current_period_end: end }] },
        latest_invoice: { id: invoiceId, status: 'paid', livemode: false, currency: 'usd', amount_due: 10000, amount_paid: 10000, amount_remaining: 0, total: 10000, customer: 'cus_owner',
            parent: { subscription_details: { subscription: 'sub_business' } },
            lines: { has_more: false, data: [{ amount: 10000, currency: 'usd', quantity: 1, period: { start, end }, pricing: { price_details: { price: settings.priceId } }, parent: { subscription_item_details: { subscription: 'sub_business', subscription_item: 'si_business', proration: false } } }] },
        },
    };
}
function session(subscriptionId = 'sub_business') {
    return { id: 'cs_test_owner', mode: 'subscription', status: 'complete', payment_status: 'paid', livemode: false, subscription: subscriptionId, customer: 'cus_owner', metadata: { spotlight: MARKER, owner_key: 'owner_key', ...profileMetadata(profile) } };
}
function recorder() {
    return { headers: {}, statusCode: null, body: null, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function cookie(sessionId = 'cs_test_owner') {
    const response = recorder(); setOwnerCookie(response, sessionId, settings); return response.headers['set-cookie'].split(';')[0];
}
function request(body = {}, ownerCookie = '') { return { method: 'POST', headers: { origin: settings.siteUrl, 'content-type': 'application/json', cookie: ownerCookie }, body }; }
function mockStripe(initialSubscription = subscription()) {
    const state = { subscription: initialSubscription, session: session(), updates: [], checkouts: [], portals: [], expirations: [], price: price(), listingPages: null, chargeChanges: {}, refundHistory: [] };
    const real = new Stripe(settings.secret);
    const stripe = {
        webhooks: real.webhooks,
        prices: { retrieve: async () => structuredClone(state.price) },
        invoicePayments: { list: async params => ({ has_more: false, data: [{ status: 'paid', livemode: false, amount_paid: 10000, currency: 'usd', invoice: params.invoice, payment: { type: 'payment_intent', payment_intent: { id: 'pi_current', status: 'succeeded', livemode: false, amount: 10000, amount_received: 10000, currency: 'usd', customer: 'cus_owner', latest_charge: 'ch_current' } } }] }) },
        charges: { retrieve: async () => ({ id: 'ch_current', payment_intent: 'pi_current', customer: 'cus_owner', livemode: false, status: 'succeeded', paid: true, captured: true, amount: 10000, amount_captured: 10000, currency: 'usd', amount_refunded: 0, refunded: false, disputed: false, ...state.chargeChanges }) },
        refunds: { list: async () => ({ has_more: false, data: structuredClone(state.refundHistory) }) },
        subscriptions: {
            retrieve: async (subscriptionId) => { assert.equal(subscriptionId, state.subscription.id); return structuredClone(state.subscription); },
            list: async (params) => state.listingPages ? state.listingPages(params) : { has_more: false, data: state.subscription ? [structuredClone(state.subscription)] : [] },
            update: async (subscriptionId, params, options) => { assert.equal(subscriptionId, state.subscription.id); state.updates.push({ subscriptionId, params, options }); Object.assign(state.subscription.metadata, params.metadata); return structuredClone(state.subscription); },
        },
        checkout: { sessions: {
            retrieve: async (sessionId) => { assert.equal(sessionId, state.session.id); return structuredClone(state.session); },
            expire: async (sessionId) => { state.expirations.push(sessionId); state.session.status = 'expired'; },
            create: async (params, options) => { state.checkouts.push({ params, options }); return { id: 'cs_test_newowner', url: 'https://checkout.stripe.com/c/pay/cs_test_newowner' }; },
        } },
        billingPortal: { sessions: { create: async (params) => { state.portals.push(params); return { url: 'https://billing.stripe.com/p/session/testing' }; } } },
    };
    return { stripe, state };
}
function handler(stripe, overrides = {}) { return createHandler({ makeStripe: () => stripe, getConfig: () => ({ ...settings, ...overrides }) }); }
function event(type = 'invoice.paid', invoiceId = 'in_current') { return { id: 'evt_delivery', object: 'event', type, livemode: false, data: { object: type.startsWith('checkout') ? { id: 'cs_test_owner' } : type.startsWith('customer') ? { id: 'sub_business' } : { id: invoiceId, parent: { subscription_details: { subscription: 'sub_business' } } } } }; }

async function post(stripe, body, ownerCookie = '', overrides = {}) {
    const response = recorder(); await handler(stripe, overrides)(request(body, ownerCookie), response); return response;
}

test('checkout fixes price, amount, customer ownership and recurring terms on the server', async () => {
    const { stripe, state } = mockStripe();
    const body = { op: 'checkout', profile, consent: true, requestId: crypto.randomUUID(), priceId: 'price_cheap', customer: 'cus_attacker', amount: 1 };
    const result = await post(stripe, body);
    assert.equal(result.statusCode, 200);
    assert.match(result.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
    assert.match(result.headers['set-cookie'], new RegExp(`^${COOKIE_NAME}=`));
    const { params, options } = state.checkouts[0];
    assert.deepEqual(params.line_items, [{ price: settings.priceId, quantity: 1 }]);
    assert.equal(params.mode, 'subscription');
    assert.equal(params.customer_email, profile.email);
    assert.equal(params.customer, undefined);
    assert.equal(params.payment_method_types, undefined);
    assert.match(params.integration_identifier, /^spotlight_[a-z]{8}$/);
    assert.equal(params.subscription_data.metadata.spotlight, MARKER);
    assert.equal(params.subscription_data.metadata.spotlight_review_status, 'pending');
    assert.match(params.custom_text.submit.message, /review.*2 days/i);
    assert.match(params.custom_text.submit.message, /refund/i);
    assert.deepEqual(params.subscription_data.billing_mode, { type: 'flexible' });
    assert.equal(params.subscription_data.metadata.email, undefined);
    assert.equal(params.subscription_data.metadata.spotlight_paid_invoice, undefined);
    assert.equal(params.success_url, `${settings.siteUrl}/apply/?checkout=success`);
    assert.equal(params.cancel_url, `${settings.siteUrl}/apply/?checkout=canceled`);
    assert.doesNotMatch(params.success_url, /session_id/);
    assert.match(options.idempotencyKey, /^spotlight-checkout-/);
    assert.equal(ownerSessionId({ headers: { cookie: result.headers['set-cookie'] } }, settings), 'cs_test_newowner');
    const retry = await post(stripe, body);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(state.checkouts[1], state.checkouts[0]);
});

test('checkout fails closed when disabled, consent absent, request ID invalid or Stripe price mismatched', async () => {
    const body = { op: 'checkout', profile, consent: true, requestId: crypto.randomUUID() };
    const { stripe, state } = mockStripe();
    assert.equal((await post(stripe, body, '', { enabled: false })).statusCode, 503);
    assert.equal((await post(stripe, { ...body, consent: false })).statusCode, 400);
    assert.equal((await post(stripe, { ...body, requestId: 'not-a-uuid' })).statusCode, 400);
    state.price.unit_amount = 100;
    assert.equal((await post(stripe, body)).statusCode, 503);
    assert.equal(state.checkouts.length, 0);
});

test('existing owner cannot accidentally start a second active subscription', async () => {
    const { stripe, state } = mockStripe();
    const response = await post(stripe, { op: 'checkout', profile, consent: true, requestId: crypto.randomUUID() }, cookie());
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'EXISTING_SUBSCRIPTION');
    assert.equal(state.checkouts.length, 0);
});

test('strict same-origin JSON writes and body bounds reject CSRF and oversized input', async () => {
    const { stripe } = mockStripe();
    for (const origin of ['', 'https://evil.example', 'https://www.chriscerney.org.evil.example']) {
        const req = request({ op: 'status' }); req.headers.origin = origin;
        const res = recorder(); await handler(stripe)(req, res); assert.equal(res.statusCode, 403);
    }
    const req = request({ op: 'checkout', content: 'a'.repeat(9000) });
    const response = recorder(); await handler(stripe)(req, response); assert.equal(response.statusCode, 413);
    const form = request({ op: 'portal' }); form.headers['content-type'] = 'text/plain';
    const formResponse = recorder(); await handler(stripe)(form, formResponse); assert.equal(formResponse.statusCode, 415);
});

test('forgetting a device clears owner access without changing Stripe billing, even while disabled', async () => {
    const makeStripe = () => { throw new Error('Forgetting a device must not access Stripe'); };
    const endpoint = createHandler({ makeStripe, getConfig: () => ({ ...settings, secret: '', enabled: false }) });
    const response = recorder();
    await endpoint(request({ op: 'logout' }, cookie()), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'none', canManage: false, published: false });
    assert.equal(response.headers['set-cookie'], `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
    assert.equal(ownerSessionId({ headers: { cookie: response.headers['set-cookie'].split(';')[0] } }, settings), '');
    const crossSite = request({ op: 'logout' }, cookie());
    crossSite.headers.origin = 'https://evil.example';
    const denied = recorder();
    await endpoint(crossSite, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers['set-cookie'], undefined);
});

test('untrusted profiles reject script URLs, markup, credential URLs and overlong fields', () => {
    for (const website of ['javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://localhost']) assert.throws(() => validateProfile({ ...profile, website }, true));
    assert.throws(() => validateProfile({ ...profile, businessName: '<img onerror=alert(1)>' }, true));
    assert.throws(() => validateProfile({ ...profile, description: 'a'.repeat(401) }, true));
    assert.throws(() => validateProfile({ ...profile, category: 'bad category' }, true));
    assert.throws(() => validateProfile({ ...profile, email: 'bad email' }, true));
    assert.equal(validateProfile(profile).email, undefined);
    assert.equal(validateProfile({ ...profile, description: 'Coffee.\nFresh pastries.' }).description, 'Coffee. Fresh pastries.');
});

test('public directory contains only current paid and webhook-confirmed listings, with no owner or billing identifiers', async () => {
    const sub = subscription(); const { stripe, state } = mockStripe(sub);
    const service = createService(stripe, settings);
    assert.deepEqual((await service.directory()).listings, []);
    state.subscription.metadata.spotlight_paid_invoice = 'in_current';
    state.subscription.metadata.email = 'private@example.com';
    const directory = await service.directory();
    assert.deepEqual(directory.price, PRICE);
    assert.equal(directory.listings.length, 1);
    assert.equal(directory.listings[0].businessName, profile.businessName);
    const serialized = JSON.stringify(directory);
    for (const privateValue of ['private@example.com', 'owner_key', 'cus_owner', 'sub_business', 'in_current', 'cs_test']) assert.ok(!serialized.includes(privateValue));
    state.subscription.metadata.spotlight_hidden = 'true';
    assert.equal((await service.directory()).listings.length, 0);
});

test('each billing mismatch suppresses a listing even with a previously valid webhook marker', () => {
    const mutations = [
        (s) => { s.status = 'past_due'; }, (s) => { s.status = 'trialing'; }, (s) => { s.livemode = true; },
        (s) => { s.pause_collection = { behavior: 'void' }; }, (s) => { s.items.data[0].quantity = 2; },
        (s) => { s.items.data[0].price.id = 'price_other'; }, (s) => { s.items.data[0].price.currency = 'eur'; },
        (s) => { s.items.data[0].price.unit_amount = 1; }, (s) => { s.items.data[0].price.recurring.interval = 'year'; },
        (s) => { s.latest_invoice.status = 'open'; }, (s) => { s.latest_invoice.amount_paid = 0; },
        (s) => { s.latest_invoice.customer = 'cus_other'; }, (s) => { s.latest_invoice.parent.subscription_details.subscription = 'sub_other'; },
        (s) => { s.latest_invoice.lines.data[0].pricing.price_details.price = 'price_other'; },
        (s) => { s.latest_invoice.lines.data[0].parent.subscription_item_details.proration = true; },
        (s) => { s.latest_invoice.lines.data[0].period.end -= 100; },
        (s) => { s.items.data[0].current_period_start = Math.floor(Date.now() / 1000) + 3600; },
        (s) => { delete s.items.data[0].current_period_start; },
        (s) => { s.latest_invoice.lines.data[0].period.start -= 100; },
        (s) => { s.latest_invoice.amount_paid_off_stripe = 10000; }, (s) => { s.latest_invoice.post_payment_credit_notes_amount = 10000; },
        (s) => { s.latest_invoice.lines.has_more = true; },
    ];
    assert.equal(validPaidSubscription(subscription(), settings), true);
    for (const mutate of mutations) { const sub = subscription(); mutate(sub); assert.equal(validPaidSubscription(sub, settings), false, mutate.toString()); }
});

test('status never fulfills; a verified webhook publishes once and duplicate delivery is harmless', async () => {
    const { stripe, state } = mockStripe();
    const response = await post(stripe, { op: 'status' }, cookie());
    assert.equal(response.statusCode, 200); assert.equal(response.body.status, 'active'); assert.equal(response.body.published, false);
    assert.equal(state.updates.length, 0);
    const service = createService(stripe, settings);
    await service.webhook(event()); await service.webhook(event());
    assert.equal(state.updates.length, 1);
    assert.equal(state.subscription.metadata.spotlight_paid_invoice, 'in_current');
    assert.equal((await service.directory()).listings.length, 1);
});

test('renewal failure hides listing immediately; delayed older events cannot republish it', async () => {
    const { stripe, state } = mockStripe(); const service = createService(stripe, settings);
    await service.webhook(event());
    state.subscription.latest_invoice.id = 'in_renewal'; state.subscription.latest_invoice.status = 'open'; state.subscription.latest_invoice.amount_paid = 0; state.subscription.status = 'past_due';
    assert.equal((await service.directory()).listings.length, 0);
    await service.webhook(event('invoice.payment_failed', 'in_renewal'));
    await service.webhook(event('invoice.paid', 'in_current'));
    assert.equal(state.updates.length, 1); assert.equal((await service.directory()).listings.length, 0);
    state.subscription.status = 'active'; state.subscription.latest_invoice.status = 'paid'; state.subscription.latest_invoice.amount_paid = 10000;
    await service.webhook(event('invoice.payment_failed', 'in_current'));
    assert.equal(state.subscription.metadata.spotlight_paid_invoice, 'in_renewal');
    assert.equal((await service.directory()).listings.length, 1);
});

test('cancel-at-period-end keeps paid listing until cancellation; stale paid events cannot restore canceled subscription', async () => {
    const { stripe, state } = mockStripe(); const service = createService(stripe, settings);
    await service.webhook(event()); state.subscription.cancel_at_period_end = true;
    await service.webhook(event('customer.subscription.updated'));
    assert.equal((await service.directory()).listings.length, 1);
    state.subscription.status = 'canceled';
    await service.webhook(event('customer.subscription.deleted'));
    await service.webhook(event('invoice.paid'));
    assert.equal((await service.directory()).listings.length, 0);
});

test('asynchronous Checkout is not fulfilled until current payment status is paid', async () => {
    const { stripe, state } = mockStripe(); const service = createService(stripe, settings);
    state.session.payment_status = 'unpaid';
    await service.webhook(event('checkout.session.completed')); assert.equal(state.updates.length, 0);
    state.session.payment_status = 'paid';
    await service.webhook(event('checkout.session.async_payment_succeeded')); assert.equal(state.updates.length, 1);
});

test('concurrent invoice transition is reconciled to latest invoice before webhook is acknowledged', async () => {
    const { stripe, state } = mockStripe(); const normalUpdate = stripe.subscriptions.update;
    stripe.subscriptions.update = async (...args) => {
        const result = await normalUpdate(...args);
        if (state.updates.length === 1) state.subscription.latest_invoice.id = 'in_newer';
        return result;
    };
    await createService(stripe, settings).webhook(event());
    assert.equal(state.subscription.metadata.spotlight_paid_invoice, 'in_newer');
    assert.equal(state.updates.length, 2);
});

test('owner operations require signed cookie; arbitrary checkout/customer/subscription IDs cannot grant access', async () => {
    const { stripe, state } = mockStripe();
    const malicious = { sessionId: 'cs_test_owner', customer: 'cus_owner', subscriptionId: 'sub_business', profile };
    assert.equal((await post(stripe, { op: 'portal', ...malicious })).statusCode, 401);
    assert.equal((await post(stripe, { op: 'update', ...malicious })).statusCode, 401);
    const forged = cookie().slice(0, -2) + 'xx';
    assert.equal((await post(stripe, { op: 'portal' }, forged)).statusCode, 401);
    assert.equal(state.portals.length, 0); assert.equal(state.updates.length, 0);
    const portal = await post(stripe, { op: 'portal', customer: 'cus_attacker' }, cookie());
    assert.equal(portal.statusCode, 200);
    assert.deepEqual(state.portals[0], { customer: 'cus_owner', configuration: settings.portalConfigurationId, return_url: `${settings.siteUrl}/apply/#manage` });
});

test('paid profile edits are locked so owners cannot bypass approval', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = 'in_current'; state.subscription.metadata.spotlight_hidden = 'true';
    const response = await post(stripe, { op: 'update', profile: { ...profile, businessName: 'New Coast Coffee', spotlight_paid_invoice: 'in_forged', spotlight_hidden: 'false', owner_key: 'attacker' } }, cookie());
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'REVIEW_REQUIRED');
    assert.equal(state.updates.length, 0);
    assert.equal(state.subscription.metadata.business_name, 'Coast Coffee');
    assert.equal(state.subscription.metadata.owner_key, 'owner_key');
    assert.equal(state.subscription.metadata.spotlight_paid_invoice, 'in_current');
    assert.equal(state.subscription.metadata.spotlight_hidden, 'true');
    assert.equal(response.body.profile, undefined);
});

test('admin listing actions require existing administrator authentication', async () => {
    const { stripe, state } = mockStripe();
    assert.equal((await post(stripe, { op: 'admin-list' })).statusCode, 401);
    assert.equal((await post(stripe, { op: 'admin-update', subscriptionId: 'sub_business', hidden: true })).statusCode, 401);
    const res = recorder();
    await createHandler({ makeStripe: () => stripe, getConfig: () => settings, authenticateAdmin: () => true })(request({ op: 'admin-update', subscriptionId: 'sub_business', hidden: true }), res);
    assert.equal(res.statusCode, 200); assert.equal(state.subscription.metadata.spotlight_hidden, 'true');
});

test('webhook verifies raw bytes with Stripe signature and rejects parsed/tampered/expired/oversized payloads', async () => {
    const { stripe, state } = mockStripe();
    const webhook = createWebhookHandler({ makeStripe: () => stripe, getConfig: () => settings });
    const payload = JSON.stringify(event());
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: settings.webhookSecret });
    for (const [body, header] of [[Buffer.from(`${payload} `), signature], [JSON.parse(payload), signature], [Buffer.from(payload), 'bad'], [Buffer.from(payload), stripe.webhooks.generateTestHeaderString({ payload, secret: settings.webhookSecret, timestamp: 1 })], [Buffer.alloc(262145), signature]]) {
        const res = recorder(); await webhook({ method: 'POST', headers: { 'stripe-signature': header }, body }, res); assert.equal(res.statusCode, 400);
    }
    assert.equal(state.updates.length, 0);
    const req = Readable.from([Buffer.from(payload.slice(0, 30)), Buffer.from(payload.slice(30))]); req.method = 'POST'; req.headers = { 'stripe-signature': signature };
    const res = recorder(); await webhook(req, res); assert.equal(res.statusCode, 200); assert.equal(state.updates.length, 1);
});

test('webhook errors are retried and unrelated or wrong-mode events cause no mutation', async () => {
    const { stripe, state } = mockStripe();
    const service = createService(stripe, settings);
    await service.webhook({ ...event(), livemode: true }); await service.webhook({ ...event(), type: 'charge.succeeded' });
    assert.equal(state.updates.length, 0);
    stripe.subscriptions.retrieve = async () => { throw new Error('Temporary network issue'); };
    const webhook = createWebhookHandler({ makeStripe: () => stripe, getConfig: () => settings });
    const payload = JSON.stringify(event()); const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: settings.webhookSecret });
    const res = recorder(); await webhook({ method: 'POST', headers: { 'stripe-signature': signature }, body: Buffer.from(payload) }, res);
    assert.equal(res.statusCode, 500);
});

test('missing configuration leaves an empty directory with checkout disabled', async () => {
    const res = recorder();
    await handler(null, { secret: '', priceId: '', enabled: false })({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body.listings, []); assert.equal(res.body.checkoutEnabled, false);
});

test('directory, owner status and admin visibility reflect current refunds and disputes without webhook delivery', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = state.subscription.latest_invoice.id;
    const service = createService(stripe, settings);
    assert.equal((await service.directory()).listings.length, 1);
    assert.equal((await post(stripe, { op: 'status' }, cookie())).body.published, true);
    assert.equal((await service.adminList()).listings[0].published, true);
    for (const kind of ['dispute', 'untagged-refund']) {
        state.chargeChanges = kind === 'dispute' ? { disputed: true } : {};
        state.refundHistory = kind === 'untagged-refund' ? [{ payment_intent: 'pi_current', currency: 'usd', amount: 10000, status: 'succeeded', metadata: {} }] : [];
        assert.equal((await service.directory()).listings.length, 0);
        const status = (await post(stripe, { op: 'status' }, cookie())).body;
        assert.equal(status.published, false);
        assert.equal(status.canManage, true);
        assert.equal((await service.adminList()).listings[0].published, false);
    }
    assert.equal(state.updates.length, 0);
});

test('current payment API failure returns generic 502 while portal creation remains independent', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = state.subscription.latest_invoice.id;
    stripe.charges.retrieve = async () => { throw Object.assign(new Error('private provider message'), { type: 'StripeAPIError', statusCode: 503 }); };
    const response = recorder(); await handler(stripe)({ method: 'GET', headers: {} }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.code, 'STRIPE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(response.body), /private provider message/);
    assert.equal((await post(stripe, { op: 'portal' }, cookie())).statusCode, 200);
});

test('directory current-payment verification uses at most four subscription workers', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = state.subscription.latest_invoice.id;
    const rows = Array.from({ length: 13 }, (_, index) => {
        const row = structuredClone(state.subscription); row.id = `sub_business${index}`;
        row.latest_invoice.parent.subscription_details.subscription = row.id;
        return row;
    });
    state.listingPages = async () => ({ data: rows, has_more: false });
    const list = stripe.invoicePayments.list;
    let active = 0; let peak = 0;
    stripe.invoicePayments.list = async params => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        try { return await list(params); } finally { active--; }
    };
    assert.equal((await createService(stripe, settings).directory()).listings.length, 13);
    assert.equal(peak, 4);
});

test('a verification outage stops dequeuing listings and waits for its bounded in-flight batch', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = state.subscription.latest_invoice.id;
    state.listingPages = async () => ({ has_more: false, data: Array.from({ length: 20 }, () => structuredClone(state.subscription)) });
    const list = stripe.invoicePayments.list;
    const outage = Object.assign(new Error('Stripe unavailable'), { type: 'StripeAPIError' });
    let started = 0; let completed = 0;
    stripe.invoicePayments.list = async params => {
        const index = started++;
        try {
            if (index === 0) throw outage;
            await new Promise(resolve => setImmediate(resolve));
            return await list(params);
        } finally { completed++; }
    };
    await assert.rejects(createService(stripe, settings).directory(), error => error === outage);
    assert.equal(started, 4);
    assert.equal(completed, 4);
});


test('preview and development require an explicit sandbox key and never use live credentials', () => {
    const names = ['VERCEL_ENV', 'STRIPE_SECRET_KEY', 'SPOTLIGHT_STRIPE_SECRET_KEY', 'SPOTLIGHT_SESSION_SECRET', 'ADMIN_SESSION_SECRET'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
        process.env.STRIPE_SECRET_KEY = 'sk_live_store';
        delete process.env.SPOTLIGHT_STRIPE_SECRET_KEY;
        for (const environment of ['preview', 'development']) {
            process.env.VERCEL_ENV = environment;
            assert.equal(config().secret, '');
            process.env.SPOTLIGHT_STRIPE_SECRET_KEY = 'rk_live_accident';
            assert.equal(config().secret, '');
            process.env.SPOTLIGHT_STRIPE_SECRET_KEY = 'sk_test_dedicated';
            assert.equal(config().secret, 'sk_test_dedicated');
            delete process.env.SPOTLIGHT_STRIPE_SECRET_KEY;
        }
        process.env.VERCEL_ENV = 'production';
        assert.equal(config().secret, 'sk_live_store');
        process.env.SPOTLIGHT_SESSION_SECRET = 'sandbox-specific-owner-signing-secret-32chars';
        process.env.ADMIN_SESSION_SECRET = 'shared-administrator-signing-secret-32chars';
        assert.equal(config().signingSecret, process.env.SPOTLIGHT_SESSION_SECRET);
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});


test('Vercel lazy JSON body getter is never accessed when signed raw request stream is available', async () => {
    const { stripe, state } = mockStripe();
    const payload = JSON.stringify(event(), null, 2);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: settings.webhookSecret });
    const req = Readable.from([Buffer.from(payload)]);
    req.method = 'POST'; req.headers = { 'stripe-signature': signature, 'content-type': 'application/json' };
    Object.defineProperty(req, 'body', { get() { throw new Error('Vercel JSON getter must never be read'); } });
    const res = recorder();
    await createWebhookHandler({ makeStripe: () => stripe, getConfig: () => settings })(req, res);
    assert.equal(res.statusCode, 200); assert.equal(state.updates.length, 1);
});


test('expired and canceled owner sessions start a new idempotent attempt even if client reuses the old request ID', async () => {
    const body = { op: 'checkout', profile, consent: true, requestId: crypto.randomUUID() };
    const initial = mockStripe();
    await post(initial.stripe, body);
    const originalKey = initial.state.checkouts[0].options.idempotencyKey;
    for (const previousStatus of ['expired', 'canceled']) {
        const { stripe, state } = mockStripe();
        if (previousStatus === 'expired') { state.session.subscription = null; state.session.status = 'expired'; }
        else { state.subscription.status = 'canceled'; }
        const first = await post(stripe, body, cookie());
        const retry = await post(stripe, body, cookie());
        assert.equal(first.statusCode, 200); assert.equal(retry.statusCode, 200);
        assert.notEqual(state.checkouts[0].options.idempotencyKey, originalKey);
        assert.equal(state.checkouts[1].options.idempotencyKey, state.checkouts[0].options.idempotencyKey);
    }
});


test('paid invoice alone never publishes: approval must match every reviewed public field', async () => {
    const { stripe, state } = mockStripe();
    state.subscription.metadata.spotlight_paid_invoice = 'in_current';
    const service = createService(stripe, settings);
    state.subscription.metadata.spotlight_review_status = 'pending';
    assert.equal((await service.directory()).listings.length, 0);
    await service.webhook(event());
    assert.equal((await service.directory()).listings.length, 0);
    state.subscription.metadata.spotlight_review_status = 'approved';
    assert.equal((await service.directory()).listings.length, 1);
    for (const key of ['business_name', 'category', 'city', 'description', 'website', 'phone', 'logo_url']) {
        const original = state.subscription.metadata[key];
        state.subscription.metadata[key] = key === 'website' ? 'https://changed.example/' : key === 'logo_url' ? 'https://changed.example/logo.png' : key === 'category' ? 'Other' : key === 'phone' ? '8315550999' : 'Changed';
        assert.equal((await service.directory()).listings.length, 0, key);
        state.subscription.metadata[key] = original;
    }
    for (const value of ['declining', 'declined', 'needs_attention', 'approving', '']) {
        state.subscription.metadata.spotlight_review_status = value;
        assert.equal((await service.directory()).listings.length, 0, value);
    }
});

test('verified payment events hand off only the configured Spotlight subscription for durable review', async () => {
    const { stripe, state } = mockStripe(); const calls = [];
    const service = createService(stripe, { ...settings, moderationReady: true }, async (op, body) => calls.push({ op, body }));
    await service.webhook(event());
    assert.deepEqual(calls, [{ op: 'ingest', body: { subscriptionId: 'sub_business' } }]);
    state.subscription.metadata.spotlight = 'other_product';
    await service.webhook(event()); assert.equal(calls.length, 1);
    state.subscription.metadata.spotlight = MARKER; state.subscription.livemode = true;
    await service.webhook(event()); assert.equal(calls.length, 1);
});

test('review handoff failure fails webhook delivery so Stripe can retry', async () => {
    const { stripe } = mockStripe();
    const service = createService(stripe, { ...settings, moderationReady: true }, async () => { throw new Error('Temporary unavailable'); });
    await assert.rejects(service.webhook(event()), /Temporary unavailable/);
});

test('logo validation accepts optional HTTPS image URLs and rejects unsafe locations', () => {
    assert.equal(validateProfile({ ...profile, logoUrl: undefined }).logoUrl, '');
    assert.equal(validateProfile({ ...profile, logoUrl: 'https://example.com/logo.png' }).logoUrl, 'https://example.com/logo.png');
    for (const logoUrl of ['http://example.com/logo.png', 'javascript:alert(1)', 'https://127.0.0.1/x', 'https://user:pass@example.com/x', 'https://internal.local/x']) assert.throws(() => validateProfile({ ...profile, logoUrl }));
});

test('refund events reconcile only canonically verified Spotlight refunds', async () => {
    const { stripe } = mockStripe(); const calls=[]; let retrieved=0;
    stripe.refunds={retrieve:async(refundId)=>{retrieved++;return{id:refundId,metadata:{spotlight:MARKER,spotlight_subscription_id:'sub_business'}};}};
    const service=createService(stripe,{...settings,moderationReady:true},async(op,body)=>calls.push({op,body}));
    await service.webhook({type:'refund.updated',livemode:false,data:{object:{id:'re_test',metadata:{spotlight:'another_product'}}}});
    assert.equal(retrieved,0);assert.equal(calls.length,0);
    await service.webhook({type:'refund.updated',livemode:false,data:{object:{id:'re_test',metadata:{spotlight:MARKER,spotlight_subscription_id:'sub_forged'}}}});
    assert.deepEqual(calls,[{op:'ingest',body:{subscriptionId:'sub_business'}}]);
    stripe.refunds.retrieve=async()=>({metadata:{spotlight:'another_product',spotlight_subscription_id:'sub_business'}});
    await service.webhook({type:'refund.failed',livemode:false,data:{object:{id:'re_test',metadata:{spotlight:MARKER}}}});
    assert.equal(calls.length,1);
});

test('admin unhide cannot approve a pending listing', async()=>{
    const {stripe,state}=mockStripe();state.subscription.metadata.spotlight_review_status='pending';state.subscription.metadata.spotlight_paid_invoice='in_current';state.subscription.metadata.spotlight_hidden='true';
    await createService(stripe,settings).adminUpdate({subscriptionId:'sub_business',hidden:false});
    assert.equal(state.subscription.metadata.spotlight_hidden,'false');assert.equal(state.subscription.metadata.spotlight_review_status,'pending');assert.equal((await createService(stripe,settings).directory()).listings.length,0);
});

test('owner payment confirmation comes from canonical Checkout status, not subscription activity',async()=>{
 const {stripe,state}=mockStripe();state.session.payment_status='unpaid';state.subscription.metadata.spotlight_review_status='pending';
 const r=await post(stripe,{op:'status'},cookie());assert.equal(r.statusCode,200);assert.equal(r.body.paymentConfirmed,false);assert.equal(r.body.published,false);
 state.session.payment_status='paid';const confirmed=await post(stripe,{op:'status'},cookie());assert.equal(confirmed.body.paymentConfirmed,true);assert.equal(confirmed.body.published,false);
});

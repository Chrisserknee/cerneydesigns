'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviders, profileHash, MARKER } = require('./providers');

const BANNER = 'https://firebasestorage.googleapis.com/v0/b/tip-line-8c2d7.firebasestorage.app/o/_spotlight%2Fv1%2Fsandbox%2Fbanners%2F' + 'a'.repeat(64) + '.webp?alt=media&token=11111111-1111-4111-8111-111111111111';
test('approval publishes only an owned image in the correct environment and remains idempotent', async () => {
    const f = fixture(); await f.providers.hold(f.snapshot);
    for (const url of ['https://example.com/photo.jpg', BANNER.replace('sandbox', 'live')]) await assert.rejects(f.providers.approve(f.snapshot, url), { code: 'INVALID_BANNER' });
    assert.equal(f.subscription.metadata.spotlight_banner_url, undefined);
    await f.providers.approve(f.snapshot, BANNER); const count = f.calls.updates.length;
    assert.equal(f.subscription.metadata.spotlight_banner_url, BANNER); assert.equal(f.subscription.metadata.spotlight_banner_profile, f.snapshot.profileHash);
    await f.providers.approve(f.snapshot, BANNER); assert.equal(f.calls.updates.length, count);
});

function fixture(live = false) {
    const start = Math.floor(Date.now() / 1000) - 60;
    const profile = { businessName: 'Sandbox Coffee', category: 'Food & Restaurants', city: 'Monterey', description: 'A synthetic test listing.', website: 'https://example.com/', phone: '', logoUrl: '' };
    const invoice = { id: 'in_initial', livemode: live, status: 'paid', currency: 'usd', amount_paid: 10000, amount_due: 10000, total: 10000, amount_remaining: 0, amount_paid_off_stripe: 0, post_payment_credit_notes_amount: 0, customer: 'cus_test', parent: { subscription_details: { subscription: 'sub_test' } }, billing_reason: 'subscription_create', created: start, status_transitions: { paid_at: start }, lines: { has_more: false, data: [{ amount: 10000, currency: 'usd', quantity: 1, pricing: { price_details: { price: 'price_test' } }, parent: { subscription_item_details: { proration: false, subscription_item: 'si_test' } }, period: { start, end: start + 30 * 86400 } }] } };
    const subscription = { id: 'sub_test', livemode: live, customer: 'cus_test', status: 'active', cancel_at_period_end: true, metadata: { spotlight: MARKER, business_name: profile.businessName, category: profile.category, city: profile.city, description: profile.description, website: profile.website, phone: '', logo_url: '', spotlight_review_status: 'pending' }, items: { has_more: false, data: [{ id: 'si_test', quantity: 1, current_period_start: start, current_period_end: start + 30 * 86400, price: { id: 'price_test', currency: 'usd', unit_amount: 10000, type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }] }, latest_invoice: structuredClone(invoice), pause_collection: null };
    const intent = { id: 'pi_initial', livemode: live, status: 'succeeded', amount: 10000, amount_received: 10000, currency: 'usd', customer: 'cus_test', latest_charge: 'ch_initial' };
    const charge = { id: 'ch_initial', payment_intent: 'pi_initial', customer: 'cus_test', livemode: live, status: 'succeeded', paid: true, captured: true, amount: 10000, amount_captured: 10000, currency: 'usd', amount_refunded: 0, refunded: false, disputed: false };
    const payment = { status: 'paid', livemode: live, amount_paid: 10000, currency: 'usd', invoice: 'in_initial', payment: { type: 'payment_intent', payment_intent: intent } };
    const controls = { refundStatus: 'succeeded', refundsHasMore: false, loseRefundResponse: false, loseCancelResponse: false, loseApprovalResponse: false };
    const history = []; const calls = { updates: [], cancels: [], refunds: [], invoiceLists: [], paymentLists: [], email: [] }; const idempotency = new Map();
    const snapshot = { subscriptionId: 'sub_test', customerId: 'cus_test', initialInvoiceId: 'in_initial', paymentIntentId: 'pi_initial', profile, profileHash: profileHash(profile), customerEmail: 'delivered@resend.dev', paidAmount: 10000, currency: 'usd', paidAt: start * 1000, periodEnd: (start + 30 * 86400) * 1000 };
    const stripe = {
        subscriptions: {
            async retrieve() { return structuredClone(subscription); },
            async update(id, value) {
                calls.updates.push({ id, value: structuredClone(value) });
                if ('pause_collection' in value) subscription.pause_collection = value.pause_collection || null;
                Object.assign(subscription.metadata, value.metadata);
                if (controls.loseApprovalResponse && value.metadata?.spotlight_review_status === 'approved') { controls.loseApprovalResponse = false; throw new Error('Approval accepted but response lost'); }
                return structuredClone(subscription);
            },
            async cancel(id, value) {
                calls.cancels.push({ id, value }); subscription.status = 'canceled';
                if (controls.loseCancelResponse) { controls.loseCancelResponse = false; throw new Error('Cancellation accepted but response lost'); }
                return structuredClone(subscription);
            },
        },
        invoices: { async retrieve(id) { assert.equal(id, snapshot.initialInvoiceId); return structuredClone(invoice); }, async list(params) { calls.invoiceLists.push(params); return { has_more: false, data: [structuredClone(invoice)] }; } },
        invoicePayments: { async list(params) { calls.paymentLists.push(params); return { has_more: false, data: [structuredClone(payment)] }; } },
        charges: { async retrieve(chargeId) { assert.equal(chargeId, 'ch_initial'); return structuredClone(charge); } },
        customers: { async retrieve() { return { id: 'cus_test', livemode: live, email: 'delivered@resend.dev' }; } },
        refunds: {
            async list(params) { assert.equal(params.payment_intent, 'pi_initial'); return { has_more: controls.refundsHasMore, data: structuredClone(history) }; },
            async create(params, options) {
                calls.refunds.push({ params: structuredClone(params), options });
                if (!idempotency.has(options.idempotencyKey)) {
                    const refund = { id: `re_${history.length + 1}`, status: controls.refundStatus, amount: params.amount, currency: 'usd', payment_intent: params.payment_intent, created: start + history.length, metadata: params.metadata };
                    history.push(refund); idempotency.set(options.idempotencyKey, refund);
                }
                if (controls.loseRefundResponse) { controls.loseRefundResponse = false; throw new Error('Refund accepted but response lost'); }
                return structuredClone(idempotency.get(options.idempotencyKey));
            },
        },
    };
    const settings = { live, stripeKey: live ? 'rk_live_placeholder' : 'rk_test_placeholder', priceId: 'price_test', emailEnabled: true, resendKey: 're_placeholder' };
    const fetchImpl = async (url, options) => { calls.email.push({ url, options }); return { ok: true, async json() { return { id: 'mail_receipt' }; } }; };
    const providers = createProviders({ stripe, settings, fetchImpl });
    const addRefund = (changes = {}) => history.push({ id: `re_${history.length + 1}`, amount: 10000, currency: 'usd', payment_intent: 'pi_initial', status: 'succeeded', created: start + history.length, ...changes });
    return { providers, stripe, settings, subscription, invoice, payment, intent, charge, snapshot, history, controls, calls, addRefund };
}

test('initial inspection pins the genuine paid invoice, PaymentIntent and submitted profile', async () => {
    const f = fixture(); const snapshot = await f.providers.inspectInitial('sub_test');
    assert.deepEqual(snapshot, f.snapshot);
    assert.deepEqual(f.calls.paymentLists[0], { invoice: 'in_initial', status: 'paid', limit: 100, expand: ['data.payment.payment_intent'] });
    f.subscription.latest_invoice = { ...f.invoice, id: 'in_renewal', billing_reason: 'subscription_cycle' };
    assert.equal((await f.providers.inspectInitial('sub_test')).initialInvoiceId, 'in_initial');
    assert.equal(f.calls.invoiceLists.length, 1);
});

test('foreign and unpaid subscriptions never create applications; mismatched paid receipts are rejected', async () => {
    const f = fixture(); f.subscription.metadata.spotlight = 'sponsorship';
    assert.equal(await f.providers.inspectInitial('sub_test'), null);
    f.subscription.metadata.spotlight = MARKER; f.subscription.status = 'incomplete';
    assert.equal(await f.providers.inspectInitial('sub_test'), null);
    f.subscription.status = 'active'; f.payment.amount_paid = 9999;
    await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PAYMENT_MISMATCH' });
    assert.equal(f.calls.updates.length, 0); assert.equal(f.calls.refunds.length, 0);
});

test('live objects, wrong prices, multiple items and credit-funded invoices cannot pass validation', async () => {
    for (const mutate of [
        (f) => { f.subscription.livemode = true; },
        (f) => { f.subscription.items.data[0].price.id = 'price_other'; },
        (f) => { f.subscription.items.has_more = true; },
        (f) => { f.subscription.latest_invoice.amount_paid_off_stripe = 10000; },
        (f) => { f.subscription.latest_invoice.post_payment_credit_notes_amount = 100; },
        (f) => { f.intent.customer = 'cus_other'; },
    ]) { const f = fixture(); mutate(f); await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PAYMENT_MISMATCH' }); }
    assert.throws(() => createProviders({ stripe: {}, settings: { stripeKey: 'rk_live_placeholder' } }), { code: 'MODE_MISMATCH' });
});

test('refunds and unreviewable profiles cannot enter the paid review workflow', async () => {
    const f = fixture(); f.addRefund({ status: 'pending' });
    await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PAYMENT_REFUNDED' });
    f.history.length = 0; f.subscription.metadata.logo_url = 'https://127.0.0.1/logo.png';
    await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PROFILE_CHANGED' });
    f.subscription.metadata.logo_url = ''; f.subscription.metadata.business_name = '<script>';
    await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PROFILE_CHANGED' });
});

test('review hold voids future collection, is idempotent, and preserves customer cancellation', async () => {
    const f = fixture(); await f.providers.hold(f.snapshot); await f.providers.hold(f.snapshot);
    assert.equal(f.calls.updates.length, 1);
    assert.deepEqual(f.subscription.pause_collection, { behavior: 'void' });
    assert.equal(f.subscription.cancel_at_period_end, true);
    assert.equal('cancel_at_period_end' in f.calls.updates[0].value, false);
    assert.equal(f.subscription.metadata.spotlight_review_hold, 'true');
    assert.equal(f.subscription.metadata.spotlight_approved_profile, '');
});

test('an unrelated billing pause cannot be overridden by the application hold or approval', async () => {
    const f = fixture(); f.subscription.pause_collection = { behavior: 'keep_as_draft' };
    await assert.rejects(f.providers.hold(f.snapshot), { code: 'BILLING_CHANGED' });
    await assert.rejects(f.providers.approve(f.snapshot), { code: 'BILLING_CHANGED' });
    assert.equal(f.calls.updates.length, 0);
});

test('approval clears only its own hold, pins the reviewed hash and preserves cancellation', async () => {
    const f = fixture(); await f.providers.hold(f.snapshot);
    f.controls.loseApprovalResponse = true;
    await assert.rejects(f.providers.approve(f.snapshot), /response lost/);
    await f.providers.approve(f.snapshot);
    assert.equal(f.calls.updates.length, 2);
    assert.equal(f.subscription.pause_collection, null);
    assert.equal(f.subscription.metadata.spotlight_review_status, 'approved');
    assert.equal(f.subscription.metadata.spotlight_approved_profile, f.snapshot.profileHash);
    assert.equal(f.subscription.cancel_at_period_end, true);
    assert.ok(f.calls.updates.every((call) => !('cancel_at_period_end' in call.value)));
});

test('approval refuses changed profile, expired service, refunds or canceled billing', async () => {
    for (const mutate of [
        (f) => { f.subscription.metadata.website = 'https://changed.example/'; },
        (f) => { f.subscription.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 1; },
        (f) => { f.addRefund(); },
        (f) => { f.subscription.status = 'canceled'; },
    ]) { const f = fixture(); await f.providers.hold(f.snapshot); mutate(f); await assert.rejects(f.providers.approve(f.snapshot), { status: 409 }); assert.equal(f.subscription.metadata.spotlight_review_status, 'pending'); }
});

test('approval cannot publish a disputed, partially refunded or mismatched canonical current charge', async () => {
    for (const mutate of [
        f => { f.charge.disputed = true; }, f => { f.charge.amount_refunded = 1; },
        f => { f.charge.customer = 'cus_foreign'; }, f => { f.charge.payment_intent = 'pi_foreign'; },
        f => { f.payment.invoice = 'in_foreign'; }, f => { f.intent.customer = 'cus_foreign'; },
        f => { f.intent.latest_charge = null; }, f => { f.intent.livemode = !f.settings.live; },
    ]) {
        const f = fixture(); await f.providers.hold(f.snapshot); mutate(f);
        await assert.rejects(f.providers.approve(f.snapshot), { status: 409 });
        assert.equal(f.subscription.metadata.spotlight_review_status, 'pending');
        assert.equal(f.subscription.pause_collection.behavior, 'void');
        assert.equal(f.calls.updates.length, 1);
        assert.equal(f.calls.refunds.length, 0);
    }
});

test('cancel retries a lost response safely and never generates a final invoice or proration', async () => {
    const f = fixture(); f.controls.loseCancelResponse = true;
    await assert.rejects(f.providers.cancel(f.snapshot, 'Outside the service area.'), /response lost/);
    await f.providers.cancel(f.snapshot, 'Outside the service area.');
    assert.equal(f.calls.cancels.length, 1);
    assert.deepEqual(f.calls.cancels[0], { id: 'sub_test', value: { invoice_now: false, prorate: false } });
    assert.equal(f.subscription.metadata.spotlight_decline_reason, 'Outside the service area.');
    assert.equal(f.subscription.metadata.spotlight_review_status, 'declined');
    assert.equal(f.subscription.metadata.spotlight_approved_profile, '');
});

test('refund requires canceled billing and always targets the pinned initial payment', async () => {
    const f = fixture(); await assert.rejects(f.providers.refund(f.snapshot), { code: 'CANCELLATION_REQUIRED' });
    await f.providers.cancel(f.snapshot, 'Not eligible.');
    f.subscription.latest_invoice = { ...f.invoice, id: 'in_renewal', billing_reason: 'subscription_cycle' };
    const result = await f.providers.refund(f.snapshot);
    assert.deepEqual(result, { status: 'succeeded', refundId: 're_1', refundedAmount: 10000 });
    assert.equal(f.calls.refunds[0].params.payment_intent, 'pi_initial');
    assert.equal(f.calls.refunds[0].params.amount, 10000);
    assert.deepEqual(f.calls.refunds[0].params.metadata, { spotlight: MARKER, spotlight_subscription_id: 'sub_test', spotlight_application: 'sub_test', spotlight_decision: 'decline' });
});

test('a lost refund response reconciles existing money movement without refunding twice', async () => {
    const f = fixture(); await f.providers.cancel(f.snapshot, 'Not eligible.'); f.controls.loseRefundResponse = true;
    await assert.rejects(f.providers.refund(f.snapshot), /response lost/);
    const result = await f.providers.refund(f.snapshot);
    assert.equal(result.refundedAmount, 10000); assert.equal(f.calls.refunds.length, 1);
});

test('partial refunds only refund the remaining amount; pending/action-required refunds never duplicate', async () => {
    const f = fixture(); await f.providers.cancel(f.snapshot, 'Not eligible.'); f.addRefund({ amount: 3000 });
    assert.equal((await f.providers.refund(f.snapshot)).refundedAmount, 10000);
    assert.equal(f.calls.refunds[0].params.amount, 7000);
    for (const status of ['pending', 'requires_action']) {
        const next = fixture(); await next.providers.cancel(next.snapshot, 'Not eligible.'); next.addRefund({ status });
        assert.equal((await next.providers.refund(next.snapshot)).status, 'pending');
        assert.equal(next.calls.refunds.length, 0);
    }
});

test('failed refund retries use a new deterministic key; succeeded refunds never retry', async () => {
    const f = fixture(); await f.providers.cancel(f.snapshot, 'Not eligible.'); f.controls.refundStatus = 'failed';
    assert.equal((await f.providers.refund(f.snapshot)).status, 'failed');
    const firstKey = f.calls.refunds[0].options.idempotencyKey;
    f.controls.refundStatus = 'succeeded'; assert.equal((await f.providers.refund(f.snapshot)).status, 'succeeded');
    assert.notEqual(f.calls.refunds[1].options.idempotencyKey, firstKey);
    assert.match(f.calls.refunds[1].options.idempotencyKey, /re_1$/);
    await f.providers.refund(f.snapshot); assert.equal(f.calls.refunds.length, 2);
});

test('ambiguous, foreign or over-refunded histories fail closed without additional refunds', async () => {
    for (const mutate of [
        (f) => { f.controls.refundsHasMore = true; },
        (f) => { f.addRefund({ payment_intent: 'pi_other' }); },
        (f) => { f.addRefund({ amount: 10001 }); },
        (f) => { f.addRefund({ currency: 'eur' }); },
        (f) => { f.addRefund({ status: 'unknown' }); },
    ]) { const f = fixture(); await f.providers.cancel(f.snapshot, 'Not eligible.'); mutate(f); await assert.rejects(f.providers.refund(f.snapshot), { code: 'REFUND_REVIEW' }); assert.equal(f.calls.refunds.length, 0); }
});

test('Resend receives a bounded idempotent request with verified sender and reply-to', async () => {
    const f = fixture(); const job = { from: 'Chris Cerney <sponsorships@bookings.chriscerney.org>', to: 'delivered@resend.dev', replyTo: 'cerneymedia@gmail.com', subject: '[SANDBOX TEST] Approved', text: 'Test message.' };
    assert.deepEqual(await f.providers.sendEmail(job, 'spotlight:sub_test:applicant-approved'), { id: 'mail_receipt' });
    const request = f.calls.email[0]; assert.equal(request.url, 'https://api.resend.com/emails');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers['Idempotency-Key'], 'spotlight:sub_test:applicant-approved');
    assert.deepEqual(JSON.parse(request.options.body), { from: job.from, to: [job.to], reply_to: job.replyTo, subject: job.subject, text: job.text });
    await assert.rejects(f.providers.sendEmail({ ...job, subject: 'Injected\r\nHeader' }, 'spotlight:sub_test:bad'), { code: 'EMAIL_INVALID' });
    f.settings.emailEnabled = false; assert.equal(f.providers.emailReady(), false);
    await assert.rejects(f.providers.sendEmail(job, 'spotlight:sub_test:applicant-approved'));
    assert.equal(f.calls.email.length, 1);
});

test('paid pending applications canceled before webhook arrival are captured for owner attention', async () => {
    const f = fixture(); f.subscription.status = 'canceled';
    assert.equal((await f.providers.inspectInitial('sub_test')).paymentIntentId, 'pi_initial');
    await assert.rejects(f.providers.hold(f.snapshot), { code: 'SUBSCRIPTION_CHANGED' });
    delete f.subscription.metadata.spotlight_review_status;
    assert.equal(await f.providers.inspectInitial('sub_test'), null);
});

test('after three failed refunds automatic creation stops, but an external successful refund still reconciles', async () => {
    const f = fixture(); await f.providers.cancel(f.snapshot, 'Not eligible.'); f.controls.refundStatus = 'failed';
    for (let index = 0; index < 3; index += 1) await f.providers.refund(f.snapshot);
    const blocked = await f.providers.refund(f.snapshot);
    assert.equal(blocked.status, 'failed'); assert.equal(blocked.manualRequired, true);
    assert.equal(f.calls.refunds.length, 3);
    f.addRefund({ status: 'succeeded' });
    assert.equal((await f.providers.refund(f.snapshot)).status, 'succeeded');
    assert.equal(f.calls.refunds.length, 3);
});


test('live moderation validates live payments and rejects cross-mode objects and keys', async () => {
    const f = fixture(true);
    assert.deepEqual(await f.providers.inspectInitial('sub_test'), f.snapshot);
    await f.providers.hold(f.snapshot);
    await f.providers.approve(f.snapshot);
    assert.equal(f.subscription.metadata.spotlight_review_status, 'approved');
    f.subscription.livemode = false;
    await assert.rejects(f.providers.inspectInitial('sub_test'), { code: 'PAYMENT_MISMATCH' });
    assert.throws(() => createProviders({ stripe: {}, settings: { live: true, stripeKey: 'rk_test_wrong' } }), { code: 'MODE_MISMATCH' });
});

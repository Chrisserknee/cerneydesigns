'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBillingProvider, MARKER } = require('./member-billing-provider');
function fixture(offer = 'featured') {
    const now = 1800000000000, settings = { stripeKey: 'rk_test_fixture', live: false, priceId: 'price_base', featuredPriceId: 'price_featured', mustachePriceId: 'price_mustache', setupPriceId: 'price_setup', siteUrl: 'https://example.com' };
    const request = { id: 'request', offer, quote: { version: 'quote', amount: 125000, specialty: 'Plumber', scope: 'A video' }, billing: { sessionId: 'cs_test_extra', expiresAt: now / 1000 + 3600, integration: 'abcdefgh' } };
    const meta = { selects_extra: MARKER, selects_base: 'sub_base', selects_request: request.id, selects_offer: offer, selects_quote: request.quote.version };
    const price = (id, amount, recurring = true) => ({ id, active: true, livemode: false, unit_amount: amount, currency: 'usd', type: recurring ? 'recurring' : 'one_time', ...(recurring ? { recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } : {}) });
    const invoice = (id, sub, amount, priceId) => ({ id, livemode: false, status: 'paid', currency: 'usd', amount_paid: amount, total: amount, amount_due: amount, amount_remaining: 0, amount_paid_off_stripe: 0, post_payment_credit_notes_amount: 0, customer: 'cus_member', billing_reason: 'subscription_create', parent: { subscription_details: { subscription: sub } }, lines: { has_more: false, data: [{ amount: amount, quantity: 1, currency: 'usd', pricing: { price_details: { price: priceId } }, parent: { subscription_item_details: { proration: false } } }] } });
    const base = { id: 'sub_base', livemode: false, customer: 'cus_member', status: 'active', metadata: { spotlight: 'local_spotlight_v1', spotlight_review_status: 'approved' }, items: { has_more: false, data: [{ quantity: 1, price: price('price_base', 10000), current_period_end: now / 1000 + 3000000 }] }, latest_invoice: invoice('in_base', 'sub_base', 10000, 'price_base') };
    const extra = { id: 'sub_extra', livemode: false, customer: 'cus_member', status: 'active', metadata: meta, items: { has_more: false, data: [{ quantity: 1, price: price(`price_${offer}`, 15000), current_period_end: now / 1000 + 3000000 }] }, latest_invoice: invoice('in_extra', 'sub_extra', 15000, `price_${offer}`) };
    if (offer === 'mustache') { Object.assign(extra.latest_invoice, { amount_paid: 65000, total: 65000, amount_due: 65000 }); extra.latest_invoice.lines.data.push({ amount: 50000, quantity: 1, currency: 'usd', pricing: { price_details: { price: 'price_setup' } } }); }
    const session = { livemode: false, customer: 'cus_member', metadata: meta, status: 'complete', payment_status: 'paid', mode: 'subscription', subscription: 'sub_extra' };
    const state = { base, extra, session, prices: { price_featured: price('price_featured', 15000), price_mustache: price('price_mustache', 15000), price_setup: price('price_setup', 50000, false) }, refunds: [], charge: {}, invoicePayments: {}, calls: [] };
    const amount = key => key.endsWith('base') ? 10000 : offer === 'mustache' ? 65000 : 15000;
    const stripe = {
        subscriptions: { retrieve: async id => structuredClone(id === 'sub_base' ? state.base : state.extra), update: async (id, args) => state.calls.push({ id, args }), cancel: async (id, args) => state.calls.push({ cancel: id, args }) },
        subscriptionSchedules: { cancel: async (id, args) => state.calls.push({ cancelSchedule: id, args }) },
        prices: { retrieve: async id => structuredClone(state.prices[id]) },
        checkout: { sessions: { retrieve: async () => structuredClone(state.session), create: async (args, options) => { state.calls.push({ args, options }); return { id: 'cs_test_created', url: 'https://checkout.stripe.com/test' }; } } },
        invoicePayments: { list: async ({ invoice }) => ({ has_more: false, data: [{ status: 'paid', livemode: false, amount_paid: amount(invoice), currency: 'usd', invoice, payment: { type: 'payment_intent', payment_intent: { id: `pi_${invoice}`, livemode: false, status: 'succeeded', amount: amount(invoice), amount_received: amount(invoice), currency: 'usd', customer: 'cus_member', latest_charge: `ch_${invoice}` } }, ...(invoice === 'in_extra' ? state.invoicePayments : {}) }] }) },
        charges: { retrieve: async id => ({ id, livemode: false, payment_intent: `pi_${id.slice(3)}`, customer: 'cus_member', status: 'succeeded', paid: true, captured: true, amount: amount(id), amount_captured: amount(id), currency: 'usd', amount_refunded: 0, refunded: false, disputed: false, ...(id === 'ch_in_extra' ? state.charge : {}) }) },
        refunds: { list: async ({ payment_intent }) => ({ has_more: false, data: payment_intent === 'pi_in_extra' ? structuredClone(state.refunds) : [] }) },
    };
    return { provider: createBillingProvider({ settings, stripe, now: () => now }), state, request, settings };
}
test('canonical paid recurring invoice activates only its matching approved checkout', async () => {
    for (const offer of ['featured', 'mustache']) { const f = fixture(offer); assert.equal((await f.provider.inspect('sub_base', f.request)).state, 'active'); }
});
test('wrong-account, wrong-customer and forged quote metadata fail closed', async () => {
    for (const mutate of [s => s.session.livemode = true, s => s.session.customer = 'cus_other', s => s.session.metadata.selects_quote = 'other', s => s.extra.customer = 'cus_other', s => s.extra.items.data[0].price.unit_amount = 1, s => s.extra.items.data[0].price.id = 'price_unrelated']) {
        const f = fixture(); mutate(f.state); await assert.rejects(f.provider.inspect('sub_base', f.request));
    }
});
test('refunds, disputes, underpayments, credited invoices and unrelated invoice parents cannot activate', async () => {
    for (const mutate of [s => s.charge.amount_refunded = 15000, s => s.charge.disputed = true, s => s.charge.captured = false, s => s.invoicePayments.amount_paid = 1, s => s.extra.latest_invoice.post_payment_credit_notes_amount = 1, s => s.extra.latest_invoice.parent.subscription_details.subscription = 'sub_other', s => s.extra.latest_invoice.lines.data[0].parent.subscription_item_details.proration = true, s => s.refunds.push({ payment_intent: 'pi_in_extra', amount: 15000, currency: 'usd', status: 'pending' })]) {
        const f = fixture(); mutate(f.state); assert.equal((await f.provider.inspect('sub_base', f.request)).state, 'payment_review');
    }
});
test('fixed recurring prices and one-time setup remain separate without trusting request amounts', async () => {
    const f = fixture('mustache'); f.request.quote.amount = 1;
    await f.provider.checkout('sub_base', f.request);
    assert.deepEqual(f.state.calls[0].args.line_items, [{ price: 'price_mustache', quantity: 1 }, { price: 'price_setup', quantity: 1 }]);
    assert.equal(f.state.calls[0].args.customer, 'cus_member'); assert.equal(f.state.calls[0].args.payment_method_types, undefined);
    assert.equal(f.state.calls[0].args.automatic_tax, undefined);
});
test('inactive or misconfigured recurring prices never create checkout', async () => {
    for (const mutate of [f => f.settings.featuredPriceId = '', f => f.state.prices.price_featured.active = false, f => f.state.prices.price_featured.livemode = true, f => f.state.prices.price_featured.unit_amount = 25000, f => f.state.prices.price_featured.recurring.interval = 'year']) {
        const f = fixture(); mutate(f); await assert.rejects(f.provider.checkout('sub_base', f.request)); assert.equal(f.state.calls.length, 0);
    }
});
test('standalone cancellation schedules the current period end without creating a commitment', async () => {
    const f = fixture(); const paid = await f.provider.inspect('sub_base', f.request); await f.provider.cancel(f.request, paid);
    assert.deepEqual(f.state.calls, [{ id: 'sub_extra', args: { cancel_at_period_end: true } }]);
});
test('payment review stops further collection without a final invoice, including within a Mustache minimum', async () => {
    for (const offer of ['featured', 'mustache']) {
        const f = fixture(offer); f.state.charge.disputed = true;
        if (offer === 'mustache') { f.state.extra.schedule = 'sub_sched'; f.request.billing.minimumEnd = 1900000000; }
        const inspected = await f.provider.inspect('sub_base', f.request); assert.equal(inspected.state, 'payment_review');
        await f.provider.cancel(f.request, inspected);
        assert.deepEqual(f.state.calls, [{ ...(offer === 'mustache' ? { cancelSchedule: 'sub_sched' } : { cancel: 'sub_extra' }), args: { invoice_now: false, prorate: false } }]);
    }
});
test('asynchronous unpaid checkout waits without activating; terminal payment failure releases availability', async () => {
    const f = fixture(); f.state.session.payment_status = 'unpaid';
    f.state.extra.status = 'incomplete'; assert.equal((await f.provider.inspect('sub_base', f.request)).state, 'processing');
    f.state.extra.status = 'incomplete_expired'; assert.equal((await f.provider.inspect('sub_base', f.request)).state, 'expired');
    f.state.extra.status = 'past_due'; assert.equal((await f.provider.inspect('sub_base', f.request)).state, 'payment_review');
    assert.equal(f.state.calls.length, 0);
});

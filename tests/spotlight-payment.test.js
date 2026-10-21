'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { currentPaymentIsValid } = require('../api/_lib/spotlight-payment');

function fixture(live = true) {
    const subscription = { customer: 'cus_owner', latest_invoice: { id: 'in_current' } };
    const intent = { id: 'pi_current', livemode: live, status: 'succeeded', amount: 10000, amount_received: 10000, currency: 'usd', customer: 'cus_owner', latest_charge: 'ch_current' };
    const payment = { invoice: 'in_current', status: 'paid', livemode: live, amount_paid: 10000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: intent } };
    const charge = { id: 'ch_current', livemode: live, customer: 'cus_owner', payment_intent: 'pi_current', status: 'succeeded', paid: true, captured: true, amount: 10000, amount_captured: 10000, currency: 'usd', amount_refunded: 0, refunded: false, disputed: false };
    const payments = { data: [payment], has_more: false };
    const refunds = { data: [], has_more: false };
    const calls = [];
    const stripe = {
        invoicePayments: { list: async params => { calls.push(['invoicePayments', params]); return payments; } },
        charges: { retrieve: async chargeId => { calls.push(['charge', chargeId]); return charge; } },
        refunds: { list: async params => { calls.push(['refunds', params]); return refunds; } },
    };
    return { stripe, subscription, settings: { live }, payment, intent, charge, payments, refunds, calls, check: () => currentPaymentIsValid(stripe, subscription, { live }) };
}

test('current payment verification follows invoice to payment intent to charge with existing read endpoints', async () => {
    for (const live of [false, true]) {
        const f = fixture(live);
        assert.equal(await f.check(), true);
        assert.deepEqual(f.calls, [
            ['invoicePayments', { invoice: 'in_current', status: 'paid', limit: 2, expand: ['data.payment.payment_intent'] }],
            ['charge', 'ch_current'], ['refunds', { payment_intent: 'pi_current', limit: 100 }],
        ]);
    }
});

test('refunds and disputes remove eligibility without any webhook or optional metadata', async () => {
    for (const change of [
        f => { f.charge.disputed = true; },
        f => { f.charge.refunded = true; f.charge.amount_refunded = 10000; },
        f => { f.charge.amount_refunded = 1; },
        ...['pending', 'requires_action', 'succeeded'].map(status => f => { f.refunds.data = [{ payment_intent: 'pi_current', amount: 10000, currency: 'usd', status, metadata: {} }]; }),
    ]) { const f = fixture(); change(f); assert.equal(await f.check(), false); }
});

test('failed or canceled refund attempts do not revoke a genuine current payment', async () => {
    const f = fixture();
    f.refunds.data = ['failed', 'canceled'].map(status => ({ payment_intent: 'pi_current', amount: 10000, currency: 'usd', status }));
    assert.equal(await f.check(), true);
});

test('renewal verification scopes all reads to the current invoice and payment, not a reversed old period', async () => {
    const f = fixture();
    f.subscription.latest_invoice.id = 'in_renewal'; f.payment.invoice = 'in_renewal';
    f.intent.id = 'pi_renewal'; f.intent.latest_charge = 'ch_renewal';
    f.charge.id = 'ch_renewal'; f.charge.payment_intent = 'pi_renewal';
    // Old-period charge/refund records are intentionally not selected by these
    // exact canonical read keys, so a genuine new payment remains eligible.
    assert.equal(await f.check(), true);
    assert.equal(f.calls[0][1].invoice, 'in_renewal');
    assert.deepEqual(f.calls.slice(1), [['charge', 'ch_renewal'], ['refunds', { payment_intent: 'pi_renewal', limit: 100 }]]);
});

test('mismatched, unexpanded, incomplete and truncated payment records fail closed', async () => {
    for (const change of [
        f => { f.payments.has_more = true; }, f => { f.payments.data.push(structuredClone(f.payment)); }, f => { f.payments.data = []; },
        f => { f.payment.invoice = 'in_foreign'; }, f => { f.payment.livemode = false; }, f => { f.payment.amount_paid = 9999; }, f => { f.payment.status = 'open'; },
        f => { f.payment.payment.payment_intent = 'pi_current'; }, f => { f.payment.payment.type = 'payment_record'; },
        f => { f.intent.customer = 'cus_foreign'; }, f => { f.intent.livemode = false; }, f => { f.intent.status = 'processing'; }, f => { f.intent.amount_received = 9999; },
        f => { f.intent.latest_charge = null; }, f => { f.charge.id = 'ch_foreign'; }, f => { f.charge.payment_intent = 'pi_foreign'; }, f => { f.charge.customer = 'cus_foreign'; },
        f => { f.charge.livemode = false; }, f => { f.charge.captured = false; }, f => { f.charge.paid = false; }, f => { f.charge.amount_captured = 9999; },
        f => { delete f.charge.disputed; }, f => { f.refunds.has_more = true; },
        f => { f.refunds.data = [{ payment_intent: 'pi_foreign', amount: 10000, currency: 'usd', status: 'failed' }]; },
    ]) { const f = fixture(); change(f); assert.equal(await f.check(), false); }
});

test('Stripe network, permission and availability failures remain errors rather than negative eligibility', async () => {
    for (const [resource, method] of [['invoicePayments', 'list'], ['charges', 'retrieve'], ['refunds', 'list']]) {
        const f = fixture(); const outage = Object.assign(new Error('provider unavailable'), { type: 'StripeAPIError', statusCode: 503 });
        f.stripe[resource][method] = async () => { throw outage; };
        await assert.rejects(f.check(), error => error === outage);
    }
});

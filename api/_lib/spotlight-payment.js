'use strict';

const id = value => typeof value === 'string' ? value : value?.id || '';

// Invoice status remains paid after some payment reversals. Follow its canonical
// InvoicePayment link instead of trusting optional refund/webhook metadata.
async function currentPaymentIsValid(stripe, subscription, settings) {
    const invoiceId = id(subscription.latest_invoice);
    const customerId = id(subscription.customer);
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 2, expand: ['data.payment.payment_intent'] });
    if (payments.has_more !== false || !Array.isArray(payments.data) || payments.data.length !== 1) return false;
    const payment = payments.data[0];
    const intent = payment.payment?.payment_intent;
    if (payment.status !== 'paid' || payment.livemode !== settings.live || payment.amount_paid !== 10000 || payment.currency !== 'usd'
        || id(payment.invoice) !== invoiceId || payment.payment?.type !== 'payment_intent'
        || !intent || typeof intent !== 'object' || !id(intent) || intent.livemode !== settings.live || intent.status !== 'succeeded'
        || intent.amount !== 10000 || intent.amount_received !== 10000 || intent.currency !== 'usd' || id(intent.customer) !== customerId || !id(intent.latest_charge)) return false;
    const [charge, refunds] = await Promise.all([
        stripe.charges.retrieve(id(intent.latest_charge)),
        stripe.refunds.list({ payment_intent: intent.id, limit: 100 }),
    ]);
    if (!charge || charge.id !== id(intent.latest_charge) || charge.livemode !== settings.live || id(charge.payment_intent) !== intent.id
        || id(charge.customer) !== customerId || charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true
        || charge.amount !== 10000 || charge.amount_captured !== 10000 || charge.currency !== 'usd'
        || charge.amount_refunded !== 0 || charge.refunded !== false || charge.disputed !== false) return false;
    // Pending/action-required refunds also remove eligibility. An ambiguous or
    // truncated history fails closed; failed/canceled attempts do not revoke it.
    return refunds.has_more === false && Array.isArray(refunds.data) && refunds.data.every(refund =>
        id(refund.payment_intent) === intent.id && refund.currency === 'usd' && Number.isSafeInteger(refund.amount) && refund.amount > 0
        && ['failed', 'canceled'].includes(refund.status));
}

module.exports = { currentPaymentIsValid };

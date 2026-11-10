'use strict';

const { invoiceTerms } = require('./spotlight-custom-plans');
const id = value => typeof value === 'string' ? value : value?.id || '';

// Invoice status remains paid after some payment reversals. Follow its canonical
// InvoicePayment link instead of trusting optional refund/webhook metadata.
async function currentPaymentIsValid(stripe, subscription, settings) {
    const terms = invoiceTerms(subscription, settings);
    if (!await invoicePaymentIsValid(stripe,id(subscription.latest_invoice),id(subscription.customer),terms.amount,settings)) return false;
    return !terms.supplement || supplementalPaymentIsValid(stripe,terms.supplement,settings);
}
async function supplementalPaymentIsValid(stripe, plan, settings, knownInvoice) {
    const invoice = knownInvoice || await stripe.invoices.retrieve(plan.invoice);
    if (invoice.id !== plan.invoice || invoice.livemode !== settings.live || id(invoice.customer) !== plan.customer || invoice.status !== 'paid' || invoice.currency !== 'usd' || invoice.total !== 15000 || invoice.amount_due !== 15000 || invoice.amount_paid !== 15000 || invoice.amount_remaining !== 0 || invoice.amount_paid_off_stripe > 0 || invoice.post_payment_credit_notes_amount > 0 || invoice.pre_payment_credit_notes_amount > 0 || invoice.parent?.subscription_details?.subscription || invoice.lines?.has_more || invoice.lines?.data?.length !== 1 || invoice.lines.data[0].amount !== 15000) return false;
    return invoicePaymentIsValid(stripe,plan.invoice,plan.customer,15000,settings);
}
async function invoicePaymentIsValid(stripe, invoiceId, customerId, amount, settings) {
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 2, expand: ['data.payment.payment_intent'] });
    if (payments.has_more !== false || !Array.isArray(payments.data) || payments.data.length !== 1) return false;
    const payment = payments.data[0];
    const intent = payment.payment?.payment_intent;
    if (payment.status !== 'paid' || payment.livemode !== settings.live || payment.amount_paid !== amount || payment.currency !== 'usd'
        || id(payment.invoice) !== invoiceId || payment.payment?.type !== 'payment_intent'
        || !intent || typeof intent !== 'object' || !id(intent) || intent.livemode !== settings.live || intent.status !== 'succeeded'
        || intent.amount !== amount || intent.amount_received !== amount || intent.currency !== 'usd' || id(intent.customer) !== customerId || !id(intent.latest_charge)) return false;
    const [charge, refunds] = await Promise.all([
        stripe.charges.retrieve(id(intent.latest_charge)),
        stripe.refunds.list({ payment_intent: intent.id, limit: 100 }),
    ]);
    if (!charge || charge.id !== id(intent.latest_charge) || charge.livemode !== settings.live || id(charge.payment_intent) !== intent.id
        || id(charge.customer) !== customerId || charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true
        || charge.amount !== amount || charge.amount_captured !== amount || charge.currency !== 'usd'
        || charge.amount_refunded !== 0 || charge.refunded !== false || charge.disputed !== false) return false;
    // Pending/action-required refunds also remove eligibility. An ambiguous or
    // truncated history fails closed; failed/canceled attempts do not revoke it.
    return refunds.has_more === false && Array.isArray(refunds.data) && refunds.data.every(refund =>
        id(refund.payment_intent) === intent.id && refund.currency === 'usd' && Number.isSafeInteger(refund.amount) && refund.amount > 0
        && ['failed', 'canceled'].includes(refund.status));
}

module.exports = { currentPaymentIsValid, invoicePaymentIsValid, supplementalPaymentIsValid };

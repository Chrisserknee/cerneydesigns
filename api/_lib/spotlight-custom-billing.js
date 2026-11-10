'use strict';
const { plans } = require('./spotlight-custom-plans');
const { invoicePaymentIsValid, supplementalPaymentIsValid } = require('./spotlight-payment');
const id = v => typeof v === 'string' ? v : v?.id || '';
// This only replaces an existing item. It never sends/finalizes an invoice,
// approves a listing, creates a subscription, or resets the billing date.
async function reconcileCustomBilling(stripe, settings, event, eligible) {
    if (settings.live !== true || event.livemode !== true) return;
    const object = event.data?.object;
    const plan = plans().find(p => p.autoUpgrade === true &&
        ((event.type === 'invoice.paid' && object?.id === p.invoice) ||
         (event.type === 'customer.subscription.updated' && object?.id === p.subscription)));
    if (!plan) return;
    let sub = await stripe.subscriptions.retrieve(plan.subscription, { expand: ['latest_invoice'] });
    if (id(sub.customer) !== plan.customer || sub.livemode !== true) throw new Error('Custom billing ownership mismatch');
    if (sub.items?.data?.length !== 1 || sub.items.has_more) throw new Error('Custom billing item mismatch');
    const item = sub.items.data[0];
    // Already applied: duplicated and out-of-order events cannot bill again.
    if (item.price.id === plan.price && item.price.unit_amount === plan.amount && item.quantity === 1) return;
    if (sub.metadata?.spotlight_review_status !== 'approved' || sub.pause_collection || sub.status !== 'active' || sub.cancel_at || sub.cancel_at_period_end) return;
    if (sub.schedule || sub.pending_update || sub.trial_end || sub.automatic_tax?.enabled || sub.default_tax_rates?.length || sub.discounts?.length || item.discounts?.length || item.tax_rates?.length) throw new Error('Custom billing configuration changed; review required');
    if (item.id !== plan.item || item.quantity !== 1 || item.price.id !== settings.priceId || item.price.unit_amount !== 10000 || item.current_period_start !== plan.periodStart || item.current_period_end !== plan.periodEnd || item.current_period_end <= Math.floor(Date.now()/1000) || id(sub.latest_invoice) !== plan.initialInvoice) throw new Error('Custom billing period or price changed; review required');
    if (!await eligible(sub)) throw new Error('Custom billing listing is not eligible');
    const invoice = await stripe.invoices.retrieve(plan.invoice);
    if (invoice.status !== 'paid') return;
    if (!await supplementalPaymentIsValid(stripe, plan, settings, invoice) || !await invoicePaymentIsValid(stripe, plan.initialInvoice, plan.customer, 10000, settings)) throw new Error('Custom billing payments need review');
    const price = await stripe.prices.retrieve(plan.price);
    if (!price.active || price.livemode !== true || price.unit_amount !== 25000 || price.currency !== 'usd' || price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') throw new Error('Custom billing target price mismatch');
    // Fail on unexpected extra subscriptions rather than stack another charge.
    const customerSubs = await stripe.subscriptions.list({customer:plan.customer,status:'all',limit:100});
    if (customerSubs.has_more || customerSubs.data.some(s => s.id !== sub.id && !['canceled','incomplete_expired'].includes(s.status))) throw new Error('Additional subscription requires review');
    // Repeat the ownership/approval/cancellation check immediately before mutation.
    const fresh = await stripe.subscriptions.retrieve(sub.id, {expand:['latest_invoice']});
    const stable = s => JSON.stringify({customer:id(s.customer),status:s.status,pause:s.pause_collection,metadata:s.metadata,items:s.items,schedule:s.schedule,cancel:s.cancel_at,cancelEnd:s.cancel_at_period_end,invoice:id(s.latest_invoice)});
    if (stable(fresh) !== stable(sub)) throw new Error('Subscription changed during upgrade; retry');
    await stripe.subscriptions.update(sub.id, {
        items:[{id:item.id,price:plan.price,quantity:1}],
        proration_behavior:'none',payment_behavior:'error_if_incomplete',
    }, {idempotencyKey:`selects-custom-${plan.invoice}-v1`});
    sub = await stripe.subscriptions.retrieve(sub.id);
    if (sub.items.data.length !== 1 || sub.items.data[0].price.id !== plan.price || sub.items.data[0].current_period_end !== plan.periodEnd || id(sub.latest_invoice) !== plan.initialInvoice) throw new Error('Custom billing post-update verification failed');
}
module.exports = { reconcileCustomBilling };

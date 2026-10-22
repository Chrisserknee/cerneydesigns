'use strict';

const MARKER = 'cerney_selects_extra_v1';
const id = value => typeof value === 'string' ? value : value?.id || '';
const fail = (code = 'PAYMENT_MISMATCH') => { throw Object.assign(new Error('The payment needs review.'), { status: 409, code }); };

function createBillingProvider({ settings, stripe, now = Date.now }) {
    const live = settings.live === true;
    if (!(live ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(settings.stripeKey || '')) fail('MODE_MISMATCH');
    if (!stripe) stripe = new (require('stripe'))(settings.stripeKey, { apiVersion: '2026-08-26.dahlia', timeout: 15000, maxNetworkRetries: 2 });

    async function goodIntent(intent, customer, amount) {
        if (!intent || typeof intent !== 'object' || intent.livemode !== live || intent.status !== 'succeeded' || intent.amount !== amount || intent.amount_received !== amount || intent.currency !== 'usd' || id(intent.customer) !== customer || !id(intent.latest_charge)) return false;
        const [charge, refunds] = await Promise.all([stripe.charges.retrieve(id(intent.latest_charge)), stripe.refunds.list({ payment_intent: intent.id, limit: 100 })]);
        return charge.livemode === live && id(charge.payment_intent) === intent.id && id(charge.customer) === customer && charge.status === 'succeeded' && charge.paid === true && charge.captured === true && charge.amount === amount && charge.amount_captured === amount && charge.currency === 'usd' && charge.amount_refunded === 0 && charge.refunded === false && charge.disputed === false && refunds.has_more === false && refunds.data.every(r => id(r.payment_intent) === intent.id && r.currency === 'usd' && r.amount > 0 && ['failed', 'canceled'].includes(r.status));
    }
    async function goodInvoice(invoice, customer, amount) {
        if (!invoice || typeof invoice !== 'object' || invoice.livemode !== live || invoice.status !== 'paid' || invoice.currency !== 'usd' || invoice.amount_paid !== amount || invoice.total !== amount || invoice.amount_due !== amount || invoice.amount_remaining !== 0 || invoice.amount_paid_off_stripe > 0 || invoice.post_payment_credit_notes_amount > 0 || id(invoice.customer) !== customer) return false;
        const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 2, expand: ['data.payment.payment_intent'] });
        if (payments.has_more || payments.data.length !== 1) return false;
        const payment = payments.data[0];
        return payment.livemode === live && payment.status === 'paid' && payment.amount_paid === amount && payment.currency === 'usd' && id(payment.invoice) === invoice.id && payment.payment?.type === 'payment_intent' && await goodIntent(payment.payment.payment_intent, customer, amount);
    }
    async function base(subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
        const item = sub.items?.data?.[0];
        const invoice = sub.latest_invoice;
        const line = invoice?.lines?.data?.[0];
        const shape = sub.livemode === live && sub.metadata?.spotlight === 'local_spotlight_v1' && sub.items?.data?.length === 1 && !sub.items.has_more && item.quantity === 1 && item.price.id === settings.priceId && item.price.unit_amount === 10000 && item.price.currency === 'usd' && item.price.recurring?.interval === 'month' && item.price.recurring.interval_count === 1;
        if (!shape) fail();
        const paid = sub.status === 'active' && !sub.pause_collection && !sub.trial_end && sub.metadata.spotlight_review_status === 'approved' && sub.metadata.spotlight_hidden !== 'true' && item.current_period_end > now() / 1000 && invoice?.lines?.data?.length === 1 && !invoice.lines.has_more && line.amount === 10000 && line.quantity === 1 && !line.parent?.subscription_item_details?.proration && id(line.pricing?.price_details?.price) === settings.priceId && await goodInvoice(invoice, id(sub.customer), 10000);
        return { sub, customer: id(sub.customer), paid, continuing: paid && !sub.cancel_at_period_end && !sub.cancel_at, periodEnd: item.current_period_end };
    }
    function metadata(baseId, request) { return { selects_extra: MARKER, selects_base: baseId, selects_request: request.id, selects_offer: request.offer, selects_quote: request.quote.version }; }
    async function checkout(baseId, request) {
        const member = await base(baseId);
        if (!member.continuing) fail('PAID_MEMBER_REQUIRED');
        const q = request.quote, recurring = request.offer !== 'spotlight';
        const meta = metadata(baseId, request);
        const names = { featured: 'Cerney Selects — featured specialty', mustache: 'Cerney Selects — Mustache Stamp upgrade', spotlight: 'Cerney Selects — Spotlight video' };
        const lines = [];
        if (recurring) {
            const priceId = request.offer === 'mustache' ? settings.mustachePriceId : settings.featuredPriceId;
            if (!/^price_[A-Za-z0-9]+$/.test(priceId || '')) fail('PRICE_NOT_CONFIGURED');
            const price = await stripe.prices.retrieve(priceId);
            if (!price.active || price.livemode !== live || price.unit_amount !== 15000 || price.currency !== 'usd' || price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') fail();
            lines.push({ price: priceId, quantity: 1 });
        } else lines.push({ price_data: { currency: 'usd', unit_amount: q.amount, product_data: { name: names.spotlight, metadata: { selects_extra: MARKER } } }, quantity: 1 });
        if (request.offer === 'mustache') {
            if (!/^price_[A-Za-z0-9]+$/.test(settings.setupPriceId || '')) fail('PRICE_NOT_CONFIGURED');
            const setup = await stripe.prices.retrieve(settings.setupPriceId);
            if (!setup.active || setup.livemode !== live || setup.unit_amount !== 50000 || setup.currency !== 'usd' || setup.type !== 'one_time') fail();
            lines.push({ price: setup.id, quantity: 1 });
        }
        const description = recurring ? `$150/month in addition to your separate $100/month listing. ${request.offer === 'mustache' ? '$500 setup today. Three-month add-on minimum ($450), then monthly. The minimum survives cancellation of the base listing.' : 'Month to month. Cancel future renewals before the next billing date.'} Featured position: ${q.specialty}, throughout Monterey County. An active base listing is required for display.` : `One-time video project. Agreed scope: ${q.scope}`;
        return stripe.checkout.sessions.create({ mode: recurring ? 'subscription' : 'payment', customer: member.customer, client_reference_id: request.id, metadata: meta, line_items: lines, expires_at: request.billing.expiresAt, success_url: `${settings.siteUrl}/apply/?extra=complete#manage`, cancel_url: `${settings.siteUrl}/apply/?extra=canceled#manage`, custom_text: { submit: { message: description.slice(0, 1200) } }, ...(recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }), integration_identifier: `selects_extras_${request.billing.integration}` }, { idempotencyKey: `selects-extra-checkout:${baseId}:${request.id}:${q.version}` });
    }
    async function inspect(baseId, request) {
        const session = await stripe.checkout.sessions.retrieve(request.billing.sessionId, { expand: ['payment_intent'] });
        const member = await base(baseId);
        const meta = metadata(baseId, request);
        if (session.livemode !== live || id(session.customer) !== member.customer || Object.entries(meta).some(([k, v]) => session.metadata?.[k] !== v)) fail();
        if (session.status !== 'complete') return { state: session.status === 'expired' ? 'expired' : 'checkout', member };
        if (request.offer === 'spotlight') {
            if (session.payment_status !== 'paid') return { state: ['canceled', 'requires_payment_method'].includes(session.payment_intent?.status) ? 'expired' : 'processing', member };
            const valid = session.mode === 'payment' && session.amount_total === request.quote.amount && await goodIntent(session.payment_intent, member.customer, request.quote.amount);
            return { state: valid ? 'paid' : 'payment_review', member };
        }
        if (session.mode !== 'subscription' || !id(session.subscription)) fail();
        const sub = await stripe.subscriptions.retrieve(id(session.subscription), { expand: ['latest_invoice'] });
        const item = sub.items?.data?.[0];
        const expectedPrice = request.offer === 'mustache' ? settings.mustachePriceId : settings.featuredPriceId;
        if (sub.livemode !== live || id(sub.customer) !== member.customer || Object.entries(meta).some(([k, v]) => sub.metadata?.[k] !== v) || sub.items?.has_more || sub.items?.data?.length !== 1 || item.quantity !== 1 || item.price.id !== expectedPrice || item.price.unit_amount !== 15000 || item.price.currency !== 'usd' || item.price.recurring?.interval !== 'month' || item.price.recurring.interval_count !== 1) fail();
        if (session.payment_status !== 'paid' && !['past_due', 'unpaid'].includes(sub.status)) return { state: ['canceled', 'incomplete_expired'].includes(sub.status) ? 'expired' : 'processing', member };
        const amount = request.offer === 'mustache' && sub.latest_invoice?.billing_reason === 'subscription_create' ? 65000 : 15000;
        const invoice = sub.latest_invoice;
        const lines = invoice?.lines;
        const paid = sub.status === 'active' && !sub.pause_collection && !sub.trial_end && item.current_period_end > now() / 1000 && id(invoice?.parent?.subscription_details?.subscription) === sub.id && !lines?.has_more && lines?.data?.length === (amount === 65000 ? 2 : 1) && lines.data.every(line => line.currency === 'usd' && line.quantity === 1 && !line.parent?.subscription_item_details?.proration) && lines.data.some(line => id(line.pricing?.price_details?.price) === item.price.id && line.amount === 15000) && (amount !== 65000 || lines.data.some(line => id(line.pricing?.price_details?.price) === settings.setupPriceId && line.amount === 50000)) && await goodInvoice(invoice, member.customer, amount);
        return { state: sub.status === 'canceled' ? 'canceled' : paid ? 'active' : 'payment_review', member, subscriptionId: sub.id, subscription: sub, periodEnd: item.current_period_end, cancelAt: sub.cancel_at || (sub.cancel_at_period_end ? item.current_period_end : null) };
    }
    async function minimum(request, inspection) {
        if (request.offer !== 'mustache') return null;
        const sub = inspection.subscription;
        let schedule = sub.schedule ? await stripe.subscriptionSchedules.retrieve(id(sub.schedule)) : await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `selects-minimum:${sub.id}` });
        if (schedule.metadata?.selects_request !== request.id) {
            schedule = await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'release', metadata: { selects_request: request.id }, phases: [{ start_date: schedule.current_phase.start_date, duration: { interval: 'month', interval_count: 3 }, items: [{ price: sub.items.data[0].price.id, quantity: 1 }], proration_behavior: 'none' }], proration_behavior: 'none' }, { idempotencyKey: `selects-minimum-configure:${sub.id}` });
        }
        return { scheduleId: schedule.id, minimumEnd: schedule.phases[0].end_date };
    }
    async function cancel(request, inspection) {
        const sub = inspection.subscription;
        if (!sub || sub.status === 'canceled') return;
        // A failed, refunded or disputed payment suspends the service. Do not
        // collect future minimum-term installments for an invalid payment.
        if (inspection.state === 'payment_review') {
            const options = { invoice_now: false, prorate: false };
            if (sub.schedule) await stripe.subscriptionSchedules.cancel(id(sub.schedule), options, { idempotencyKey: `selects-payment-stop:${sub.id}` });
            else await stripe.subscriptions.cancel(sub.id, options, { idempotencyKey: `selects-payment-stop:${sub.id}` });
            return;
        }
        if (request.offer === 'mustache' && request.billing.minimumEnd > now() / 1000) {
            const schedule = await stripe.subscriptionSchedules.retrieve(request.billing.scheduleId);
            await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: 'cancel', phases: [{ start_date: schedule.phases[0].start_date, end_date: request.billing.minimumEnd, items: [{ price: sub.items.data[0].price.id, quantity: 1 }], proration_behavior: 'none' }], proration_behavior: 'none' }, { idempotencyKey: `selects-cancel-minimum:${sub.id}` });
        } else await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }, { idempotencyKey: `selects-cancel:${sub.id}` });
    }
    return { base, checkout, inspect, minimum, cancel };
}
module.exports = { createBillingProvider, MARKER };

'use strict';

const crypto = require('node:crypto');
const MARKER = 'local_spotlight_v1';
const FIELDS = ['businessName', 'category', 'city', 'description', 'website', 'phone', 'logoUrl'];
const METADATA = ['business_name', 'category', 'city', 'description', 'website', 'phone', 'logo_url'];
const CATEGORIES = ['Food & drink', 'Shopping', 'Home & auto', 'Health & wellness', 'Professional services', 'Arts & experiences', 'Other'];
const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const id = (value) => typeof value === 'string' ? value : value?.id || '';
function error(message, status = 503, code = 'RETRY_LATER') { return Object.assign(new Error(message), { status, code }); }
function profileHash(profile) { return crypto.createHash('sha256').update(JSON.stringify(FIELDS.map((key) => [key, profile[key] || '']))).digest('hex'); }
function profileFrom(metadata) {
    const profile = Object.fromEntries(FIELDS.map((key, index) => [key, String(metadata?.[METADATA[index]] || '').trim()]));
    const maximums = [100, 50, 80, 400, 300, 40, 500];
    FIELDS.forEach((key, index) => {
        if ((!profile[key] && !['phone', 'logoUrl'].includes(key)) || profile[key].length > maximums[index] || /[\u0000-\u001f\u007f<>]/.test(profile[key])) throw error('Business profile needs review.', 409, 'PROFILE_CHANGED');
    });
    if (!CATEGORIES.includes(profile.category)) throw error('Business category needs review.', 409, 'PROFILE_CHANGED');
    for (const key of ['website', 'logoUrl']) {
        if (!profile[key]) continue;
        let url; try { url = new URL(profile[key]); } catch { throw error('Business URL needs review.', 409, 'PROFILE_CHANGED'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.endsWith('.local')) throw error('Business URL needs review.', 409, 'PROFILE_CHANGED');
        profile[key] = url.href;
    }
    return profile;
}

function createProviders({ stripe, settings, fetchImpl = globalThis.fetch }) {
    const live = settings.live === true;
    const keyPattern = live ? /^(?:rk|sk)_live_/ : /^(?:rk|sk)_test_/;
    if (!keyPattern.test(settings.stripeKey || '')) throw error('Stripe mode does not match this moderation service.', 503, 'MODE_MISMATCH');
    if (!stripe) { const Stripe = require('stripe'); stripe = new Stripe(settings.stripeKey, { apiVersion: '2026-08-26.dahlia', timeout: 15000, maxNetworkRetries: 2 }); }
    const getSubscription = (subscriptionId) => stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
    function validateSubscription(subscription) {
        const items = subscription.items;
        const price = items?.data?.[0]?.price;
        if (subscription.livemode !== live || subscription.metadata?.spotlight !== MARKER || items?.has_more || items?.data?.length !== 1 || items.data[0].quantity !== 1 || price?.id !== settings.priceId || price.currency !== 'usd' || price.unit_amount !== 10000 || price.type !== 'recurring' || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed') throw error('Subscription does not match CerneySelects.', 409, 'PAYMENT_MISMATCH');
    }
    function validateInvoice(invoice, subscription, initial = false) {
        const line = invoice.lines?.data?.[0];
        if (invoice.livemode !== live || invoice.status !== 'paid' || invoice.currency !== 'usd' || invoice.amount_paid !== 10000 || invoice.amount_due !== 10000 || invoice.total !== 10000 || invoice.amount_remaining !== 0 || invoice.amount_paid_off_stripe > 0 || invoice.post_payment_credit_notes_amount > 0 || id(invoice.customer) !== id(subscription.customer) || id(invoice.parent?.subscription_details?.subscription) !== subscription.id || (initial && invoice.billing_reason !== 'subscription_create') || invoice.lines?.has_more || invoice.lines?.data?.length !== 1 || line.amount !== 10000 || line.currency !== 'usd' || line.quantity !== 1 || id(line.pricing?.price_details?.price) !== settings.priceId || line.parent?.subscription_item_details?.proration || id(line.parent?.subscription_item_details?.subscription_item) !== subscription.items.data[0].id || !Number.isInteger(line.period?.start) || !Number.isInteger(line.period?.end) || line.period.end <= line.period.start) throw error('Payment does not match the application.', 409, 'PAYMENT_MISMATCH');
    }
    function validateRefund(refund, paymentIntentId) {
        if (!refund || id(refund.payment_intent) !== paymentIntentId || refund.currency !== 'usd' || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refund.status)) throw error('Refund details need manual review.', 409, 'REFUND_REVIEW');
        return refund;
    }
    async function refunds(paymentIntentId) {
        const result = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
        if (result.has_more) throw error('Refund history needs manual review.', 409, 'REFUND_REVIEW');
        return result.data.map((refund) => validateRefund(refund, paymentIntentId));
    }
    async function initialInvoice(subscription) {
        if (subscription.latest_invoice?.billing_reason === 'subscription_create') return subscription.latest_invoice;
        let startingAfter;
        const matches = [];
        for (let page = 0; page < 5; page += 1) {
            const result = await stripe.invoices.list({ subscription: subscription.id, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
            matches.push(...result.data.filter((invoice) => invoice.billing_reason === 'subscription_create'));
            if (!result.has_more) break;
            if (!result.data.length || page === 4) throw error('Initial payment needs manual review.', 409, 'PAYMENT_MISMATCH');
            startingAfter = result.data.at(-1).id;
        }
        if (matches.length !== 1) throw error('Initial payment not found.', 409, 'PAYMENT_MISMATCH');
        return stripe.invoices.retrieve(matches[0].id);
    }
    async function inspectInitial(subscriptionId) {
        const subscription = await getSubscription(subscriptionId);
        // A paid applicant can cancel before the first webhook arrives. Capture
        // explicitly pending applications for operator review, without importing
        // old canceled Spotlight subscriptions into the new approval workflow.
        if (subscription.metadata?.spotlight !== MARKER || (subscription.status !== 'active' && !(subscription.status === 'canceled' && subscription.metadata.spotlight_review_status === 'pending'))) return null;
        validateSubscription(subscription);
        const invoice = await initialInvoice(subscription);
        validateInvoice(invoice, subscription, true);
        const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100, expand: ['data.payment.payment_intent'] });
        const payment = payments.data?.[0];
        const intent = payment?.payment?.payment_intent;
        if (payments.has_more || payments.data?.length !== 1 || payment.status !== 'paid' || payment.livemode !== live || payment.amount_paid !== 10000 || payment.currency !== 'usd' || id(payment.invoice) !== invoice.id || payment.payment.type !== 'payment_intent' || !intent || typeof intent !== 'object' || intent.livemode !== live || intent.status !== 'succeeded' || intent.amount_received !== 10000 || intent.currency !== 'usd' || id(intent.customer) !== id(subscription.customer)) throw error('Initial Stripe payment needs review.', 409, 'PAYMENT_MISMATCH');
        const customer = await stripe.customers.retrieve(id(subscription.customer));
        if (customer.deleted || customer.livemode !== live || !ADDRESS.test(customer.email || '') || customer.email.length > 254) throw error('Applicant email is unavailable.', 409, 'EMAIL_REQUIRED');
        if ((await refunds(intent.id)).some((refund) => !['failed', 'canceled'].includes(refund.status))) throw error('Initial payment has already been refunded.', 409, 'PAYMENT_REFUNDED');
        const profile = profileFrom(subscription.metadata);
        return { subscriptionId: subscription.id, customerId: customer.id, initialInvoiceId: invoice.id, paymentIntentId: intent.id, profile, profileHash: profileHash(profile), customerEmail: customer.email, paidAmount: 10000, currency: 'usd', paidAt: (invoice.status_transitions?.paid_at || invoice.created) * 1000, periodEnd: subscription.items.data[0].current_period_end * 1000 };
    }
    async function checked(snapshot) {
        const subscription = await getSubscription(snapshot.subscriptionId);
        validateSubscription(subscription);
        if (id(subscription.customer) !== snapshot.customerId) throw error('Application customer changed.', 409, 'PAYMENT_MISMATCH');
        return subscription;
    }
    async function hold(snapshot) {
        const subscription = await checked(snapshot);
        if (subscription.status !== 'active') throw error('Subscription is no longer active.', 409, 'SUBSCRIPTION_CHANGED');
        if (profileHash(profileFrom(subscription.metadata)) !== snapshot.profileHash) throw error('Application profile changed.', 409, 'PROFILE_CHANGED');
        const pause = subscription.pause_collection;
        if (pause && (subscription.metadata.spotlight_review_hold !== 'true' || pause.behavior !== 'void' || pause.resumes_at)) throw error('Billing pause needs manual review.', 409, 'BILLING_CHANGED');
        if (pause?.behavior === 'void' && subscription.metadata.spotlight_review_status === 'pending' && subscription.metadata.spotlight_review_hold === 'true') return;
        await stripe.subscriptions.update(subscription.id, { pause_collection: { behavior: 'void' }, metadata: { spotlight_review_status: 'pending', spotlight_review_hold: 'true', spotlight_approved_profile: '' } });
    }
    async function approve(snapshot) {
        const subscription = await checked(snapshot);
        if (subscription.status !== 'active') throw error('Subscription is no longer active.', 409, 'SUBSCRIPTION_CHANGED');
        if (profileHash(profileFrom(subscription.metadata)) !== snapshot.profileHash) throw error('The submitted profile changed. Approval was not published.', 409, 'PROFILE_CHANGED');
        validateInvoice(subscription.latest_invoice, subscription);
        const item = subscription.items.data[0];
        const line = subscription.latest_invoice.lines.data[0];
        const current = Math.floor(Date.now() / 1000);
        if (item.current_period_start > current || item.current_period_end <= current || line.period.start !== item.current_period_start || line.period.end !== item.current_period_end) throw error('Current paid service period needs review.', 409, 'PAYMENT_MISMATCH');
        if ((await refunds(snapshot.paymentIntentId)).some((refund) => !['failed', 'canceled'].includes(refund.status))) throw error('Initial payment was refunded.', 409, 'PAYMENT_REFUNDED');
        if (subscription.metadata.spotlight_review_status === 'approved' && subscription.metadata.spotlight_approved_profile === snapshot.profileHash && !subscription.pause_collection) return;
        if (subscription.metadata.spotlight_review_hold !== 'true' || subscription.pause_collection?.behavior !== 'void' || subscription.pause_collection.resumes_at) throw error('The application billing hold changed.', 409, 'BILLING_CHANGED');
        // Preserve cancel_at_period_end: it may be the applicant's own choice.
        await stripe.subscriptions.update(subscription.id, { pause_collection: '', metadata: { spotlight_review_status: 'approved', spotlight_review_hold: 'false', spotlight_approved_profile: snapshot.profileHash } });
    }
    async function cancel(snapshot, reason) {
        const subscription = await checked(snapshot);
        if (subscription.status !== 'canceled') await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false });
        await stripe.subscriptions.update(subscription.id, { metadata: { spotlight_review_status: 'declined', spotlight_review_hold: 'false', spotlight_approved_profile: '', spotlight_decline_reason: reason, spotlight_refund_status: 'pending' } });
    }
    async function refund(snapshot) {
        const subscription = await checked(snapshot);
        if (subscription.status !== 'canceled') throw error('Cancel future billing before refunding.', 409, 'CANCELLATION_REQUIRED');
        const invoice = await stripe.invoices.retrieve(snapshot.initialInvoiceId);
        validateInvoice(invoice, subscription, true);
        const history = await refunds(snapshot.paymentIntentId);
        let paid = history.filter((refund) => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0);
        let status;
        let requiresAction = false;
        let manualRequired = false;
        const failures = history.filter((refund) => ['failed', 'canceled'].includes(refund.status));
        let refundId = history.find((refund) => refund.status === 'succeeded')?.id || '';
        if (paid === 10000) status = 'succeeded';
        else if (paid > 10000) throw error('Refund total needs manual review.', 409, 'REFUND_REVIEW');
        else if (history.some((refund) => ['pending', 'requires_action'].includes(refund.status))) { status = 'pending'; refundId = history.find((refund) => ['pending', 'requires_action'].includes(refund.status)).id; requiresAction = history.some((refund) => refund.status === 'requires_action'); }
        else if (failures.length >= 3) { status = 'failed'; manualRequired = true; }
        else {
            const lastFailure = failures.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))[0];
            const key = `spotlight-decline-${snapshot.subscriptionId}-${paid}-${lastFailure?.id || 'first'}`;
            const created = await stripe.refunds.create({ payment_intent: snapshot.paymentIntentId, amount: 10000 - paid, metadata: { spotlight: MARKER, spotlight_subscription_id: snapshot.subscriptionId, spotlight_application: snapshot.subscriptionId, spotlight_decision: 'decline' } }, { idempotencyKey: key });
            validateRefund(created, snapshot.paymentIntentId);
            if (created.amount !== 10000 - paid) throw error('Refund amount needs manual review.', 409, 'REFUND_REVIEW');
            refundId = created.id;
            status = created.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(created.status) ? 'failed' : 'pending';
            requiresAction = created.status === 'requires_action';
            manualRequired = status === 'failed' && failures.length + 1 >= 3;
            if (created.status === 'succeeded') paid += created.amount;
            if (status === 'succeeded' && paid !== 10000) throw error('Full refund is not confirmed.', 409, 'REFUND_REVIEW');
        }
        await stripe.subscriptions.update(subscription.id, { metadata: { spotlight_refund_status: status } });
        return { status, refundId, refundedAmount: paid, ...(requiresAction ? { requiresAction: true } : {}), ...(manualRequired ? { manualRequired: true } : {}) };
    }
    function emailReady() { return settings.emailEnabled === true && /^re_[A-Za-z0-9_-]+$/.test(settings.resendKey || ''); }
    async function sendEmail(job, key) {
        if (!emailReady()) throw error('Spotlight email delivery is not enabled.');
        if (!ADDRESS.test(job.to || '') || /[\r\n]/.test(job.subject || '') || !job.text || !/^[A-Za-z0-9_.:-]{1,250}$/.test(key)) throw error('Invalid email job.', 409, 'EMAIL_INVALID');
        const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${settings.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ from: job.from, to: [job.to], reply_to: job.replyTo, subject: job.subject, text: job.text }) });
        if (!response.ok) throw error('Email provider did not accept the message.');
        let data; try { data = await response.json(); } catch { throw error('Email provider receipt unavailable.'); }
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(data?.id || '')) throw error('Email provider receipt unavailable.');
        return { id: data.id };
    }
    return { inspectInitial, hold, approve, cancel, refund, emailReady, sendEmail, emailIdempotencyWindowMs: 23 * 3600000 };
}
module.exports = { createProviders, profileHash, profileFrom, MARKER };

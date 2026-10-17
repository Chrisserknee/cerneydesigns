'use strict';

const crypto = require('node:crypto');
const Stripe = require('stripe');

const MARKER = 'local_spotlight_v1';
const API_VERSION = '2026-08-26.dahlia';
const COOKIE_NAME = '__Host-cc_spotlight';
const COOKIE_SECONDS = 180 * 24 * 60 * 60;
const PRICE = Object.freeze({ amount: 10000, currency: 'usd', interval: 'month' });
const CATEGORIES = Object.freeze(['Food & drink', 'Shopping', 'Home & auto', 'Health & wellness', 'Professional services', 'Arts & experiences', 'Other']);
const PUBLIC_FIELDS = ['businessName', 'category', 'city', 'description', 'website', 'phone'];
const META_FIELDS = { businessName: 'business_name', category: 'category', city: 'city', description: 'description', website: 'website', phone: 'phone' };
const WEBHOOK_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted']);

class SpotlightError extends Error {
    constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}

function config() {
    const nonProduction = ['preview', 'development'].includes(process.env.VERCEL_ENV);
    const configuredKey = String(process.env.SPOTLIGHT_STRIPE_SECRET_KEY || (!nonProduction && process.env.STRIPE_SECRET_KEY) || '').trim();
    // Preview/development must use an explicitly configured sandbox key. Never fall
    // back to the existing store's live key or allow a live key to accept test orders.
    const secret = nonProduction && /^(?:sk|rk)_live_/.test(configuredKey) ? '' : configuredKey;
    const signingSecret = String(process.env.SPOTLIGHT_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '');
    const priceId = String(process.env.SPOTLIGHT_PRICE_ID || '').trim();
    const webhookSecret = String(process.env.SPOTLIGHT_WEBHOOK_SECRET || '').trim();
    const portalConfigurationId = String(process.env.SPOTLIGHT_PORTAL_CONFIGURATION_ID || '').trim();
    let siteUrl = '';
    try {
        const url = new URL(process.env.SITE_URL || 'https://www.chriscerney.org');
        if (url.protocol === 'https:' && !url.username && !url.password) siteUrl = url.origin;
    } catch { /* Invalid configuration fails closed. */ }
    const portalLoginUrl = safeStripeUrl(process.env.SPOTLIGHT_PORTAL_LOGIN_URL, 'billing.stripe.com');
    const enabled = process.env.SPOTLIGHT_ENABLED === 'true' && Boolean(secret && signingSecret.length >= 32 && /^price_[A-Za-z0-9]+$/.test(priceId) && webhookSecret && /^bpc_[A-Za-z0-9]+$/.test(portalConfigurationId) && siteUrl);
    return { secret, signingSecret, priceId, webhookSecret, portalConfigurationId, siteUrl, portalLoginUrl, enabled, live: /^(?:sk|rk)_live_/.test(secret) };
}

function safeStripeUrl(value, hostname) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
}

function createStripe(settings = config()) {
    return new Stripe(settings.secret, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 15000, appInfo: { name: 'Chris Cerney Local Spotlight', version: '1.0.0' } });
}

function validateProfile(input, requireEmail = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SpotlightError('Enter your business details.');
    const profile = {};
    for (const [name, max] of Object.entries({ businessName: 100, category: 50, city: 80, description: 400, website: 300, phone: 40 })) {
        const raw = input[name] === undefined && name === 'phone' ? '' : input[name];
        if (typeof raw !== 'string') throw new SpotlightError(`Enter a valid ${name}.`);
        const value = (name === 'description' ? raw.replace(/\r\n|\r|\n/g, ' ') : raw).trim();
        if ((!value && name !== 'phone') || value.length > max || /[\u0000-\u001f\u007f<>]/.test(value)) throw new SpotlightError(`Enter a valid ${name} (up to ${max} characters).`);
        profile[name] = value;
    }
    if (!CATEGORIES.includes(profile.category)) throw new SpotlightError('Choose a business category.');
    try {
        const url = new URL(profile.website);
        if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname)) throw new Error('Invalid URL');
        profile.website = url.href;
        if (profile.website.length > 300) throw new Error('URL too long');
    } catch { throw new SpotlightError('Enter a complete HTTPS business website address.'); }
    if (profile.phone && (!/^[+\d().\- xext]+$/i.test(profile.phone) || !/\d/.test(profile.phone))) throw new SpotlightError('Enter a valid business phone number.');
    if (requireEmail) {
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new SpotlightError('Enter a valid billing email.');
        profile.email = email;
    }
    return profile;
}

function profileMetadata(profile) {
    return Object.fromEntries(PUBLIC_FIELDS.map((key) => [META_FIELDS[key], profile[key] || '']));
}

function readProfile(metadata) {
    try { return validateProfile(Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, metadata?.[META_FIELDS[key]] || '']))); }
    catch { return null; }
}

function hmac(value, settings) {
    return crypto.createHmac('sha256', settings.signingSecret).update(`local-spotlight-owner-v1:${value}`).digest('base64url');
}

function setOwnerCookie(response, sessionId, settings) {
    const payload = Buffer.from(JSON.stringify({ v: 1, sessionId, exp: Math.floor(Date.now() / 1000) + COOKIE_SECONDS })).toString('base64url');
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${payload}.${hmac(payload, settings)}; Max-Age=${COOKIE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function ownerSessionId(request, settings) {
    if (settings.signingSecret.length < 32) return '';
    const cookie = String(request.headers?.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (!cookie) return '';
    const [payload, signature, extra] = cookie.slice(COOKIE_NAME.length + 1).split('.');
    if (!payload || !signature || extra || payload.length > 1000) return '';
    const expected = Buffer.from(hmac(payload, settings));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return '';
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.v === 1 && data.exp > Date.now() / 1000 && /^cs_(?:live|test)_[A-Za-z0-9]+$/.test(data.sessionId) ? data.sessionId : '';
    } catch { return ''; }
}

function sameOrigin(request, settings) {
    // Browser POSTs must carry an exact Origin; missing Origin never bypasses CSRF checks.
    return Boolean(settings.siteUrl && request.headers?.origin === settings.siteUrl && request.headers?.['sec-fetch-site'] !== 'cross-site');
}

function id(value) { return typeof value === 'string' ? value : value?.id || ''; }
function isSpotlight(subscription) { return subscription?.metadata?.spotlight === MARKER; }
function validPrice(price, settings) {
    return price && price.id === settings.priceId && price.currency === PRICE.currency && price.unit_amount === PRICE.amount && price.type === 'recurring'
        && price.billing_scheme === 'per_unit' && price.recurring?.interval === PRICE.interval && price.recurring?.interval_count === 1 && price.recurring?.usage_type === 'licensed';
}

function validPaidSubscription(subscription, settings, now = Math.floor(Date.now() / 1000)) {
    if (!isSpotlight(subscription) || subscription.status !== 'active' || subscription.livemode !== settings.live || subscription.pause_collection || subscription.trial_end > now) return false;
    if (subscription.items?.has_more || subscription.items?.data?.length !== 1) return false;
    const item = subscription.items.data[0];
    if (item.quantity !== 1 || !validPrice(item.price, settings) || !Number.isInteger(item.current_period_start) || item.current_period_start <= 0 || item.current_period_start > now || !(item.current_period_end > now)) return false;
    const invoice = subscription.latest_invoice;
    if (!invoice || typeof invoice !== 'object' || invoice.status !== 'paid' || invoice.livemode !== settings.live || invoice.currency !== PRICE.currency || invoice.amount_paid !== PRICE.amount || invoice.amount_due !== PRICE.amount || invoice.total !== PRICE.amount || invoice.amount_remaining !== 0 || invoice.amount_paid_off_stripe > 0 || invoice.post_payment_credit_notes_amount > 0) return false;
    if (id(invoice.parent?.subscription_details?.subscription) !== subscription.id || id(invoice.customer) !== id(subscription.customer)) return false;
    if (invoice.lines?.has_more || invoice.lines?.data?.length !== 1) return false;
    const line = invoice.lines.data[0];
    if (id(line.pricing?.price_details?.price) !== settings.priceId || line.quantity !== 1 || line.amount !== PRICE.amount || line.currency !== PRICE.currency || line.parent?.subscription_item_details?.proration) return false;
    if (id(line.parent?.subscription_item_details?.subscription_item) !== item.id || !(line.period?.end > now) || line.period.end !== item.current_period_end || line.period.start !== item.current_period_start) return false;
    return true;
}

function published(subscription, settings) {
    return validPaidSubscription(subscription, settings) && subscription.metadata.spotlight_paid_invoice === id(subscription.latest_invoice) && subscription.metadata.spotlight_hidden !== 'true' && Boolean(readProfile(subscription.metadata));
}

function publicListing(subscription) {
    return { id: crypto.createHash('sha256').update(`spotlight:${subscription.id}`).digest('hex').slice(0, 20), ...readProfile(subscription.metadata) };
}

function createService(stripe, settings = config()) {
    async function subscriptionById(subscriptionId) {
        return stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
    }

    async function owner(request) {
        const sessionId = ownerSessionId(request, settings);
        if (!sessionId) return null;
        let session;
        try { session = await stripe.checkout.sessions.retrieve(sessionId); }
        catch (error) { if (error.code === 'resource_missing') return null; throw error; }
        if (session.mode !== 'subscription' || session.metadata?.spotlight !== MARKER || session.livemode !== settings.live) return null;
        const subscription = id(session.subscription) ? await subscriptionById(id(session.subscription)) : null;
        if (subscription && (!isSpotlight(subscription) || subscription.metadata.owner_key !== session.metadata.owner_key || id(subscription.customer) !== id(session.customer))) return null;
        return { session, subscription };
    }

    function ownerStatus(record) {
        if (!record) return { status: 'none', canManage: false, published: false };
        const { session, subscription } = record;
        if (!subscription) return { status: session.status === 'expired' ? 'expired' : 'pending', profile: readProfile(session.metadata), canManage: false, published: false };
        const status = ['canceled', 'incomplete_expired'].includes(subscription.status) ? 'canceled'
            : ['past_due', 'unpaid', 'paused'].includes(subscription.status) ? 'past_due'
                : subscription.status === 'active' ? 'active' : 'pending';
        return { status, hidden: subscription.metadata.spotlight_hidden === 'true', profile: readProfile(subscription.metadata), canManage: Boolean(id(subscription.customer) && settings.portalConfigurationId), published: published(subscription, settings), cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end), currentPeriodEnd: subscription.items?.data?.[0]?.current_period_end || null };
    }

    async function listSubscriptions(status = 'active') {
        const subscriptions = [];
        let startingAfter;
        // Explicit bounded pagination avoids silent partial results as the directory grows.
        for (let page = 0; page < 20; page += 1) {
            const result = await stripe.subscriptions.list({ price: settings.priceId, status, limit: 100, expand: ['data.latest_invoice'], ...(startingAfter ? { starting_after: startingAfter } : {}) });
            subscriptions.push(...result.data.filter(isSpotlight));
            if (!result.has_more) return subscriptions;
            if (!result.data.length) throw new Error('Invalid Stripe pagination');
            startingAfter = result.data[result.data.length - 1].id;
        }
        throw new Error('Spotlight pagination limit exceeded');
    }

    async function directory() {
        const subscriptions = settings.secret && settings.priceId ? await listSubscriptions() : [];
        return { listings: subscriptions.filter((subscription) => published(subscription, settings)).map(publicListing).sort((a, b) => a.businessName.localeCompare(b.businessName)), checkoutEnabled: settings.enabled, price: PRICE, portalLoginUrl: settings.portalLoginUrl };
    }

    async function checkout(request, response, body) {
        if (!settings.enabled) throw new SpotlightError('Spotlight sign-ups are not available yet.', 503, 'CHECKOUT_DISABLED');
        if (body.consent !== true) throw new SpotlightError('Agree to the monthly subscription terms before continuing.');
        if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new SpotlightError('Refresh the page and try again.');
        const profile = validateProfile(body.profile, true);
        const profileHash = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
        const existing = await owner(request);
        if (existing?.subscription && !['canceled', 'incomplete_expired'].includes(existing.subscription.status)) throw new SpotlightError('You already have a Spotlight subscription. Manage your existing spot below.', 409, 'EXISTING_SUBSCRIPTION');
        if (existing?.session.status === 'open') {
            if (existing.session.metadata.profile_hash === profileHash) {
                const url = safeStripeUrl(existing.session.url, 'checkout.stripe.com');
                if (url) { setOwnerCookie(response, existing.session.id, settings); return { url }; }
            }
            await stripe.checkout.sessions.expire(existing.session.id);
        }
        const price = await stripe.prices.retrieve(settings.priceId);
        if (!price.active || !validPrice(price, settings) || price.livemode !== settings.live) throw new SpotlightError('Spotlight billing is not available yet.', 503, 'INVALID_CONFIGURATION');
        // A signed previous session scopes a new attempt after expiry/cancellation.
        // Retrying a lost response with the same previous cookie remains idempotent,
        // while a completed/expired Checkout can never be resurrected for 24 hours.
        const previousSession = existing?.session.id || 'initial';
        const ownerKey = hmac(`checkout:${body.requestId.toLowerCase()}:${previousSession}`, settings);
        const metadata = { spotlight: MARKER, owner_key: ownerKey, profile_hash: profileHash, ...profileMetadata(profile) };
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription', integration_identifier: 'spotlight_qcnrhwka',
            line_items: [{ price: settings.priceId, quantity: 1 }],
            customer_email: profile.email,
            metadata,
            subscription_data: { metadata, billing_mode: { type: 'flexible' } },
            success_url: `${settings.siteUrl}/spotlightsignup/?checkout=success`,
            cancel_url: `${settings.siteUrl}/spotlightsignup/?checkout=canceled`,
            billing_address_collection: 'auto',
            custom_text: { submit: { message: 'Local Spotlight is a paid business listing for $100 USD per month, renewing automatically. Cancel future renewals from Manage billing.' } },
        }, { idempotencyKey: `spotlight-checkout-${ownerKey}` });
        const url = safeStripeUrl(session.url, 'checkout.stripe.com');
        if (!url || !/^cs_(?:live|test)_[A-Za-z0-9]+$/.test(session.id)) throw new Error('Stripe did not return a Checkout URL');
        setOwnerCookie(response, session.id, settings);
        return { url };
    }

    async function status(request, response) {
        const record = await owner(request);
        if (record) setOwnerCookie(response, record.session.id, settings);
        return ownerStatus(record);
    }

    async function portal(request) {
        const record = await owner(request);
        if (!record?.subscription || !id(record.subscription.customer)) throw new SpotlightError('Open this page in the browser used to purchase your spot, or use the billing email sign-in link.', 401, 'OWNER_REQUIRED');
        if (!settings.portalConfigurationId) throw new SpotlightError('Billing management is temporarily unavailable.', 503);
        const session = await stripe.billingPortal.sessions.create({ customer: id(record.subscription.customer), configuration: settings.portalConfigurationId, return_url: `${settings.siteUrl}/spotlightsignup/#manage` });
        const url = safeStripeUrl(session.url, 'billing.stripe.com');
        if (!url) throw new Error('Stripe did not return a billing portal URL');
        return { url };
    }

    async function update(request, body) {
        const record = await owner(request);
        if (!record?.subscription) throw new SpotlightError('Your listing session is required to edit this spot.', 401, 'OWNER_REQUIRED');
        const profile = validateProfile(body.profile);
        const subscription = await stripe.subscriptions.update(record.subscription.id, { metadata: profileMetadata(profile) });
        // Re-read invoice state, rather than relying on an unexpanded update response.
        return ownerStatus({ session: record.session, subscription: await subscriptionById(subscription.id) });
    }

    async function adminList() {
        return { listings: (await listSubscriptions('all')).map((subscription) => ({ subscriptionId: subscription.id, profile: readProfile(subscription.metadata), status: subscription.status, hidden: subscription.metadata.spotlight_hidden === 'true', published: published(subscription, settings) })) };
    }

    async function adminUpdate(body) {
        if (!/^sub_[A-Za-z0-9]+$/.test(body.subscriptionId || '') || typeof body.hidden !== 'boolean') throw new SpotlightError('Choose a valid listing and visibility.');
        const subscription = await subscriptionById(body.subscriptionId);
        if (!isSpotlight(subscription)) throw new SpotlightError('Listing not found.', 404);
        await stripe.subscriptions.update(subscription.id, { metadata: { spotlight_hidden: String(body.hidden) } });
        return { updated: true };
    }

    async function reconcile(subscriptionId) {
        // Event delivery order is irrelevant: always use current Stripe state. Check again
        // after writing so two simultaneous renewal deliveries converge on the newest invoice.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const subscription = await subscriptionById(subscriptionId);
            if (!validPaidSubscription(subscription, settings)) return;
            const invoiceId = id(subscription.latest_invoice);
            if (subscription.metadata.spotlight_paid_invoice === invoiceId) return;
            await stripe.subscriptions.update(subscription.id, { metadata: { spotlight_paid_invoice: invoiceId } });
        }
        const latest = await subscriptionById(subscriptionId);
        if (validPaidSubscription(latest, settings) && latest.metadata.spotlight_paid_invoice !== id(latest.latest_invoice)) throw new Error('Concurrent subscription change; retry reconciliation');
    }

    async function webhook(event) {
        if (!WEBHOOK_EVENTS.has(event.type) || event.livemode !== settings.live) return;
        const object = event.data?.object;
        if (event.type.startsWith('checkout.session.')) {
            // Fetch the current session. The signed event can be delayed or superseded.
            const session = await stripe.checkout.sessions.retrieve(object.id);
            if (session.mode !== 'subscription' || session.payment_status !== 'paid' || session.metadata?.spotlight !== MARKER || !id(session.subscription)) return;
            await reconcile(id(session.subscription));
        } else if (event.type.startsWith('invoice.')) {
            const subscriptionId = id(object.parent?.subscription_details?.subscription);
            if (subscriptionId) await reconcile(subscriptionId);
        } else if (/^sub_[A-Za-z0-9]+$/.test(object?.id || '')) {
            await reconcile(object.id);
        }
    }

    return { directory, checkout, status, portal, update, adminList, adminUpdate, webhook };
}

module.exports = { API_VERSION, CATEGORIES, COOKIE_NAME, MARKER, PRICE, SpotlightError, WEBHOOK_EVENTS, config, createService, createStripe, ownerSessionId, profileMetadata, published, readProfile, safeStripeUrl, sameOrigin, setOwnerCookie, validPaidSubscription, validateProfile };

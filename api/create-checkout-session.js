'use strict';

const MAX_ITEM_QUANTITY = 10;
const MAX_CART_QUANTITY = 25;
const CATALOG_VERSION = 'sticker-drop-2';

const productPriceEnvironment = {
    'sticker-4-inch': 'STRIPE_PRICE_STICKER_4_INCH',
    'sticker-2-inch': 'STRIPE_PRICE_STICKER_2_INCH',
};

const productVariants = {
    'sticker-4-inch': new Set(['stay-classy']),
    'sticker-2-inch': new Set(['gold-holographic', 'coastal-blue', 'silver-holographic']),
};

function sendJson(response, status, body) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(status).json(body);
}

function parseBody(request) {
    if (Buffer.isBuffer(request.body)) {
        return JSON.parse(request.body.toString('utf8'));
    }

    if (typeof request.body === 'string') {
        return JSON.parse(request.body);
    }

    return request.body;
}

function validateItems(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
        return null;
    }

    const merged = new Map();
    for (const item of value) {
        if (!item || !Object.hasOwn(productPriceEnvironment, item.id)) return null;
        if (typeof item.variant !== 'string' || !productVariants[item.id].has(item.variant)) return null;
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) return null;
        const key = `${item.id}::${item.variant}`;
        merged.set(key, (merged.get(key) || 0) + item.quantity);
    }

    const items = Array.from(merged, ([key, quantity]) => {
        const [id, variant] = key.split('::');
        return { id, variant, quantity };
    });
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    if (items.some((item) => item.quantity > MAX_ITEM_QUANTITY) || totalQuantity > MAX_CART_QUANTITY) {
        return null;
    }

    return items;
}

function configuredPriceItems(items) {
    return items.map((item) => ({
        ...item,
        price: (process.env[productPriceEnvironment[item.id]] || '').trim(),
    }));
}

function commaSeparatedEnvironment(name, fallback = '') {
    return (process.env[name] || fallback)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

module.exports = async function createCheckoutSession(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
    }

    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(response, 415, { error: 'JSON request required.', code: 'INVALID_CONTENT_TYPE' });
    }

    let body;
    try {
        body = parseBody(request);
    } catch {
        return sendJson(response, 400, { error: 'Invalid JSON.', code: 'INVALID_JSON' });
    }

    const items = validateItems(body?.items);
    if (!items) {
        return sendJson(response, 400, { error: 'Invalid cart.', code: 'INVALID_CART' });
    }

    if (process.env.CHECKOUT_ENABLED !== 'true') {
        return sendJson(response, 503, { error: 'Checkout is not open.', code: 'CHECKOUT_DISABLED' });
    }

    const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    const shippingRateIds = commaSeparatedEnvironment('STRIPE_SHIPPING_RATE_IDS');
    const priceItems = configuredPriceItems(items);

    if (!secretKey || shippingRateIds.length === 0 || priceItems.some((item) => !item.price)) {
        return sendJson(response, 503, { error: 'Checkout is not configured.', code: 'CHECKOUT_NOT_CONFIGURED' });
    }

    if (shippingRateIds.length > 5) {
        return sendJson(response, 500, { error: 'Checkout configuration is invalid.', code: 'INVALID_CONFIGURATION' });
    }

    if (priceItems.some((item) => !/^price_[A-Za-z0-9]+$/.test(item.price))
        || shippingRateIds.some((id) => !/^shr_[A-Za-z0-9]+$/.test(id))) {
        return sendJson(response, 500, { error: 'Checkout configuration is invalid.', code: 'INVALID_CONFIGURATION' });
    }

    const siteUrl = (process.env.SITE_URL || 'https://www.chriscerney.org').replace(/\/$/, '');
    const countries = commaSeparatedEnvironment('STRIPE_SHIPPING_COUNTRIES', 'US')
        .map((country) => country.toUpperCase())
        .filter((country) => /^[A-Z]{2}$/.test(country));

    if (countries.length === 0) {
        return sendJson(response, 500, { error: 'Checkout configuration is invalid.', code: 'INVALID_CONFIGURATION' });
    }

    const parameters = new URLSearchParams();
    parameters.set('mode', 'payment');
    parameters.set('success_url', `${siteUrl}/merchandise/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    parameters.set('cancel_url', `${siteUrl}/merchandise/?checkout=cancelled`);
    parameters.set('phone_number_collection[enabled]', 'true');
    parameters.set('billing_address_collection', 'auto');
    parameters.set('submit_type', 'pay');
    parameters.set('metadata[catalog_version]', CATALOG_VERSION);
    parameters.set('metadata[item_ids]', priceItems.map((item) => item.id).join(','));
    parameters.set('metadata[item_selections]', priceItems.map((item) => `${item.id}:${item.variant}:${item.quantity}`).join('|'));
    parameters.set('payment_intent_data[metadata][catalog_version]', CATALOG_VERSION);
    parameters.set('payment_intent_data[metadata][item_selections]', priceItems.map((item) => `${item.id}:${item.variant}:${item.quantity}`).join('|'));

    priceItems.forEach((item, index) => {
        parameters.set(`line_items[${index}][price]`, item.price);
        parameters.set(`line_items[${index}][quantity]`, String(item.quantity));
    });

    countries.forEach((country, index) => {
        parameters.set(`shipping_address_collection[allowed_countries][${index}]`, country);
    });

    shippingRateIds.forEach((shippingRateId, index) => {
        parameters.set(`shipping_options[${index}][shipping_rate]`, shippingRateId);
    });

    if (process.env.STRIPE_AUTOMATIC_TAX === 'true') {
        parameters.set('automatic_tax[enabled]', 'true');
    }

    if (process.env.STRIPE_ALLOW_PROMOTION_CODES === 'true') {
        parameters.set('allow_promotion_codes', 'true');
    }

    try {
        const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: parameters,
            signal: AbortSignal.timeout(12000),
        });
        const session = await stripeResponse.json();

        if (!stripeResponse.ok || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) {
            console.error('Stripe Checkout session creation failed', {
                status: stripeResponse.status,
                type: session?.error?.type,
                code: session?.error?.code,
                param: session?.error?.param,
                message: session?.error?.message,
            });
            return sendJson(response, 502, { error: 'Checkout is temporarily unavailable.', code: 'STRIPE_ERROR' });
        }

        return sendJson(response, 200, { url: session.url });
    } catch (error) {
        console.error('Stripe Checkout request failed', { name: error?.name });
        return sendJson(response, 502, { error: 'Checkout is temporarily unavailable.', code: 'STRIPE_UNAVAILABLE' });
    }
};

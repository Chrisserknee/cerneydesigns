'use strict';

const { getInventorySnapshot } = require('./_lib/stripe-store');
const { bundle, CATALOG_VERSION } = require('./_lib/store-catalog');

const MAX_ITEM_QUANTITY = 10;
const MAX_CART_QUANTITY = 25;
const SMALL_ORDER_SHIPPING = 99;
const BUNDLE_ORDER_SHIPPING = 199;
const LARGE_ORDER_SHIPPING = 299;
const SUPPORTER_BUNDLE_LOOKUP_KEY = 'independent_news_supporter_bundle_v4';

const cachedVariantPrices = new Map();

const productPriceEnvironment = {
    'independent-news-supporter-bundle': 'STRIPE_PRICE_SUPPORTER_BUNDLE',
    'sticker-4-inch': 'STRIPE_PRICE_STICKER_4_INCH',
    'sticker-2-inch': 'STRIPE_PRICE_STICKER_2_INCH',
};

const catalog = {
    'independent-news-supporter-bundle': {
        name: 'Independent News Supporter Bundle - Three Colorways + 4-Inch Stay Classy',
        description: 'One 4-inch Stay Classy sticker and three available 2-inch holographic colorways.',
        unitAmount: 2999,
        variants: {
            'complete-four-sticker-set': 'Complete four-sticker set',
        },
    },
    'sticker-4-inch': {
        name: '4-Inch Stay Classy Sticker',
        description: 'Holographic Stay Classy Central Coast sticker.',
        unitAmount: 1300,
        imagePath: '/images/merchandise/stay-classy-4-inch.webp',
        variants: {
            'stay-classy': 'Stay Classy Central Coast',
        },
    },
    'sticker-2-inch': {
        name: '2-Inch Chris Cerney Sticker',
        description: 'Round holographic Chris Cerney portrait sticker.',
        unitAmount: 600,
        variants: {
            'gold-holographic': {
                name: 'Gold Holographic',
                imagePath: '/images/merchandise/chris-cerney-gold-holographic.webp',
            },
            'coastal-blue': {
                name: 'Coastal Blue',
                imagePath: '/images/merchandise/chris-cerney-coastal-blue.webp',
            },
            'silver-holographic': {
                name: 'Silver Holographic',
                imagePath: '/images/merchandise/chris-cerney-silver-holographic.webp',
            },
        },
    },
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

function requestBodyIsTooLarge(request) {
    const contentLength = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > 16 * 1024) return true;
    if (Buffer.isBuffer(request.body)) return request.body.length > 16 * 1024;
    if (typeof request.body === 'string') return Buffer.byteLength(request.body, 'utf8') > 16 * 1024;
    return false;
}

function isAllowedBrowserOrigin(request, siteUrl) {
    const origin = String(request.headers.origin || '').trim();
    if (!origin) return true;
    try {
        return new URL(origin).origin === new URL(siteUrl).origin;
    } catch {
        return false;
    }
}

function ordersArePaused() {
    return process.env.CHECKOUT_PAUSE_OVERRIDE !== 'off';
}

function validateItems(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
        return null;
    }

    const merged = new Map();
    for (const item of value) {
        if (!item || !Object.hasOwn(catalog, item.id)) return null;
        if (typeof item.variant !== 'string' || !Object.hasOwn(catalog[item.id].variants, item.variant)) return null;
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

function commaSeparatedEnvironment(name, fallback = '') {
    return (process.env[name] || fallback)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

function configuredPriceItems(items) {
    return items.map((item) => ({
        ...item,
        price: item.id === 'independent-news-supporter-bundle'
            ? ''
            : (process.env[productPriceEnvironment[item.id]] || '').trim(),
    }));
}

async function stripeRequest(secretKey, path, options = {}) {
    const stripeResponse = await fetch(`https://api.stripe.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${secretKey}`,
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(12000),
    });
    const body = await stripeResponse.json();
    return { stripeResponse, body };
}

function isSupporterBundlePrice(price) {
    return /^price_[A-Za-z0-9]+$/.test(price?.id || '')
        && price.active === true
        && price.currency === 'usd'
        && price.unit_amount === catalog['independent-news-supporter-bundle'].unitAmount;
}

async function findSupporterBundlePrice(secretKey) {
    const query = new URLSearchParams({ active: 'true', limit: '1' });
    query.append('lookup_keys[]', SUPPORTER_BUNDLE_LOOKUP_KEY);
    const { stripeResponse, body } = await stripeRequest(secretKey, `/v1/prices?${query}`);
    if (!stripeResponse.ok) {
        throw new Error(`Stripe price lookup failed with status ${stripeResponse.status}`);
    }
    return isSupporterBundlePrice(body?.data?.[0]) ? body.data[0].id : '';
}

async function resolveSupporterBundlePrice(secretKey) {
    const existingPrice = await findSupporterBundlePrice(secretKey);
    if (existingPrice) return existingPrice;

    const product = catalog['independent-news-supporter-bundle'];
    const parameters = new URLSearchParams({
        currency: 'usd',
        unit_amount: String(product.unitAmount),
        lookup_key: SUPPORTER_BUNDLE_LOOKUP_KEY,
        'product_data[name]': product.name,
        'metadata[catalog_version]': CATALOG_VERSION,
        'metadata[shipping_cents]': String(BUNDLE_ORDER_SHIPPING),
    });
    const { stripeResponse, body } = await stripeRequest(secretKey, '/v1/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
    });

    if (stripeResponse.ok && isSupporterBundlePrice(body)) {
        return body.id;
    }

    // A simultaneous cold start may have created the lookup key first.
    const racedPrice = await findSupporterBundlePrice(secretKey);
    if (racedPrice) return racedPrice;
    throw new Error(`Stripe price creation failed with status ${stripeResponse.status}`);
}

function smallStickerPriceSpec(item) {
    if (item.id !== 'sticker-2-inch') return null;
    const variant = catalog[item.id].variants[item.variant];
    return {
        lookupKey: `chris_cerney_2in_${item.variant.replace(/-/g, '_')}_v1`,
        name: `${catalog[item.id].name} - ${variant.name}`,
        unitAmount: catalog[item.id].unitAmount,
    };
}

function isVariantPrice(price, spec) {
    return /^price_[A-Za-z0-9]+$/.test(price?.id || '')
        && price.active === true
        && price.currency === 'usd'
        && price.unit_amount === spec.unitAmount;
}

async function findVariantPrice(secretKey, spec) {
    const query = new URLSearchParams({ active: 'true', limit: '1' });
    query.append('lookup_keys[]', spec.lookupKey);
    const { stripeResponse, body } = await stripeRequest(secretKey, `/v1/prices?${query}`);
    if (!stripeResponse.ok) {
        throw new Error(`Stripe variant price lookup failed with status ${stripeResponse.status}`);
    }
    return isVariantPrice(body?.data?.[0], spec) ? body.data[0].id : '';
}

async function resolveVariantPrice(secretKey, spec) {
    if (cachedVariantPrices.has(spec.lookupKey)) return cachedVariantPrices.get(spec.lookupKey);

    const existingPrice = await findVariantPrice(secretKey, spec);
    if (existingPrice) {
        cachedVariantPrices.set(spec.lookupKey, existingPrice);
        return existingPrice;
    }

    const parameters = new URLSearchParams({
        currency: 'usd',
        unit_amount: String(spec.unitAmount),
        lookup_key: spec.lookupKey,
        'product_data[name]': spec.name,
        'metadata[catalog_version]': CATALOG_VERSION,
        'metadata[receipt_variant]': 'true',
    });
    const { stripeResponse, body } = await stripeRequest(secretKey, '/v1/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
    });

    if (stripeResponse.ok && isVariantPrice(body, spec)) {
        cachedVariantPrices.set(spec.lookupKey, body.id);
        return body.id;
    }

    const racedPrice = await findVariantPrice(secretKey, spec);
    if (racedPrice) {
        cachedVariantPrices.set(spec.lookupKey, racedPrice);
        return racedPrice;
    }
    throw new Error(`Stripe variant price creation failed with status ${stripeResponse.status}`);
}

async function resolvePriceItems(items, secretKey) {
    const priceItems = configuredPriceItems(items);
    for (const item of priceItems) {
        const variantPriceSpec = smallStickerPriceSpec(item);
        if (variantPriceSpec) {
            item.price = await resolveVariantPrice(secretKey, variantPriceSpec);
        }
        if (!item.price && item.id === 'independent-news-supporter-bundle') {
            item.price = await resolveSupporterBundlePrice(secretKey);
        }
    }
    return priceItems;
}

function shippingAmountFor(items) {
    if (items.some((item) => item.id === 'sticker-4-inch')) return LARGE_ORDER_SHIPPING;
    if (items.some((item) => item.id === 'independent-news-supporter-bundle')) return BUNDLE_ORDER_SHIPPING;
    return SMALL_ORDER_SHIPPING;
}

function itemDetailsFor(items) {
    return items.map((item) => {
        const variant = catalog[item.id].variants[item.variant];
        const variantName = typeof variant === 'string' ? variant : variant.name;
        return `${catalog[item.id].name} - ${variantName} x${item.quantity}`;
    }).join(' | ');
}

function inventoryCanFulfill(items, inventory) {
    if (!inventory?.fullyTracked) return true;
    const demand = new Map(inventory.items.map((item) => [item.sku, 0]));
    for (const item of items) {
        if (item.id === 'independent-news-supporter-bundle') {
            Object.entries(bundle.components).forEach(([sku, componentQuantity]) => {
                if (demand.has(sku)) demand.set(sku, demand.get(sku) + (item.quantity * componentQuantity));
            });
        } else {
            const sku = `${item.id}:${item.variant}`;
            if (demand.has(sku)) demand.set(sku, demand.get(sku) + item.quantity);
        }
    }
    return inventory.items.every((item) => demand.get(item.sku) <= item.remaining);
}

module.exports = async function createCheckoutSession(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
    }

    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(response, 415, { error: 'JSON request required.', code: 'INVALID_CONTENT_TYPE' });
    }

    if (requestBodyIsTooLarge(request)) {
        return sendJson(response, 413, { error: 'Request is too large.', code: 'REQUEST_TOO_LARGE' });
    }

    const siteUrl = (process.env.SITE_URL || 'https://www.chriscerney.org').replace(/\/$/, '');
    if (!isAllowedBrowserOrigin(request, siteUrl)) {
        return sendJson(response, 403, { error: 'Request origin is not allowed.', code: 'INVALID_ORIGIN' });
    }

    if (ordersArePaused()) {
        return sendJson(response, 503, { error: 'Sticker ordering is temporarily paused.', code: 'ORDERS_PAUSED' });
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

    if (process.env.CHECKOUT_ENABLED !== 'true' || process.env.CHECKOUT_ACCOUNT_APPROVED !== 'true') {
        return sendJson(response, 503, { error: 'Checkout is not open.', code: 'CHECKOUT_DISABLED' });
    }

    const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secretKey) {
        return sendJson(response, 503, { error: 'Checkout is not configured.', code: 'CHECKOUT_NOT_CONFIGURED' });
    }

    if (process.env.INVENTORY_TRACKING_ENABLED === 'true') {
        try {
            const { inventory } = await getInventorySnapshot({ fresh: true });
            if (!inventoryCanFulfill(items, inventory)) {
                return sendJson(response, 409, { error: 'One or more stickers just sold out. Please refresh your cart.', code: 'OUT_OF_STOCK' });
            }
        } catch (error) {
            console.error('Inventory validation failed', { name: error?.name, status: error?.status, code: error?.code });
            return sendJson(response, 503, { error: 'Inventory could not be confirmed. Please try again.', code: 'INVENTORY_UNAVAILABLE' });
        }
    }

    let priceItems;
    try {
        priceItems = await resolvePriceItems(items, secretKey);
    } catch (error) {
        console.error('Stripe catalog resolution failed', { name: error?.name, message: error?.message });
        return sendJson(response, 502, { error: 'Checkout is temporarily unavailable.', code: 'STRIPE_UNAVAILABLE' });
    }

    if (priceItems.some((item) => !item.price)) {
        return sendJson(response, 503, { error: 'Checkout is not configured.', code: 'CHECKOUT_NOT_CONFIGURED' });
    }

    if (priceItems.some((item) => !/^price_[A-Za-z0-9]+$/.test(item.price))) {
        return sendJson(response, 500, { error: 'Checkout configuration is invalid.', code: 'INVALID_CONFIGURATION' });
    }

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
    parameters.set('metadata[item_details]', itemDetailsFor(priceItems));
    parameters.set('payment_intent_data[metadata][catalog_version]', CATALOG_VERSION);
    parameters.set('payment_intent_data[metadata][item_selections]', priceItems.map((item) => `${item.id}:${item.variant}:${item.quantity}`).join('|'));
    parameters.set('payment_intent_data[metadata][item_details]', itemDetailsFor(priceItems));

    priceItems.forEach((item, index) => {
        parameters.set(`line_items[${index}][price]`, item.price);
        parameters.set(`line_items[${index}][quantity]`, String(item.quantity));
    });

    countries.forEach((country, index) => {
        parameters.set(`shipping_address_collection[allowed_countries][${index}]`, country);
    });

    const shippingAmount = shippingAmountFor(priceItems);
    parameters.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    parameters.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(shippingAmount));
    parameters.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    parameters.set('shipping_options[0][shipping_rate_data][display_name]', 'USPS sticker shipping');
    parameters.set('shipping_options[0][shipping_rate_data][metadata][catalog_version]', CATALOG_VERSION);
    const orderSize = shippingAmount === LARGE_ORDER_SHIPPING
        ? 'includes-4-inch'
        : shippingAmount === BUNDLE_ORDER_SHIPPING ? 'supporter-bundle' : '2-inch-only';
    parameters.set('shipping_options[0][shipping_rate_data][metadata][order_size]', orderSize);

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

        let checkoutUrl;
        try {
            checkoutUrl = new URL(session.url);
        } catch {
            checkoutUrl = null;
        }

        if (!stripeResponse.ok || !checkoutUrl || checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
            console.error('Stripe Checkout session creation failed', {
                status: stripeResponse.status,
                type: session?.error?.type,
                code: session?.error?.code,
                param: session?.error?.param,
                message: session?.error?.message,
            });
            return sendJson(response, 502, { error: 'Checkout is temporarily unavailable.', code: 'STRIPE_ERROR' });
        }

        return sendJson(response, 200, { url: checkoutUrl.href });
    } catch (error) {
        console.error('Stripe Checkout request failed', { name: error?.name });
        return sendJson(response, 502, { error: 'Checkout is temporarily unavailable.', code: 'STRIPE_UNAVAILABLE' });
    }
};

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const createCheckoutSession = require('../api/create-checkout-session');
const checkoutSessionStatus = require('../api/checkout-session-status');

function responseRecorder() {
    return {
        headers: {},
        statusCode: null,
        body: null,
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function checkoutRequest(overrides = {}) {
    return {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'https://www.chriscerney.org',
        },
        body: {
            items: [{ id: 'sticker-2-inch', variant: 'black-gold-holographic', quantity: 1 }],
        },
        ...overrides,
    };
}

function configureCheckoutEnvironment() {
    process.env.CHECKOUT_ENABLED = 'true';
    process.env.CHECKOUT_ACCOUNT_APPROVED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    process.env.STRIPE_PRICE_STICKER_2_INCH = 'price_small';
    process.env.STRIPE_PRICE_STICKER_4_INCH = 'price_large';
    process.env.STRIPE_PRICE_SUPPORTER_BUNDLE = 'price_bundle';
    process.env.SITE_URL = 'https://www.chriscerney.org';
}

test('checkout rejects cross-site browser requests', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const response = responseRecorder();
    await createCheckoutSession(checkoutRequest({
        headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    }), response);

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'INVALID_ORIGIN');
});

test('checkout rejects oversized request bodies', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const response = responseRecorder();
    await createCheckoutSession(checkoutRequest({
        headers: {
            'content-type': 'application/json',
            origin: 'https://www.chriscerney.org',
            'content-length': String(17 * 1024),
        },
    }), response);

    assert.equal(response.statusCode, 413);
    assert.equal(response.body.code, 'REQUEST_TOO_LARGE');
});

test('checkout rejects Stripe lookalike redirect hosts', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const previousFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://checkout.stripe.com.attacker.example/session' }),
    });
    try {
        const response = responseRecorder();
        await createCheckoutSession(checkoutRequest({
            body: {
                items: [{ id: 'sticker-4-inch', variant: 'stay-classy', quantity: 1 }],
            },
        }), response);
        assert.equal(response.statusCode, 502);
        assert.equal(response.body.code, 'STRIPE_ERROR');
    } finally {
        global.fetch = previousFetch;
    }
});

test('checkout status confirms only paid sessions from this catalog', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const previousFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            metadata: { catalog_version: 'sticker-drop-8' },
        }),
    });
    try {
        const response = responseRecorder();
        await checkoutSessionStatus({
            method: 'GET',
            query: { session_id: `cs_live_${'A'.repeat(24)}` },
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.confirmed, true);
    } finally {
        global.fetch = previousFetch;
    }
});

test('checkout status does not confirm unpaid or foreign-catalog sessions', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const previousFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'payment',
            status: 'complete',
            payment_status: 'unpaid',
            metadata: { catalog_version: 'other-store' },
        }),
    });
    try {
        const response = responseRecorder();
        await checkoutSessionStatus({
            method: 'GET',
            query: { session_id: `cs_live_${'B'.repeat(24)}` },
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.confirmed, false);
    } finally {
        global.fetch = previousFetch;
    }
});

test('supporter bundle resolves its current Stripe Price and special shipping amount', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const previousFetch = global.fetch;
    const requests = [];
    let stripeParameters;
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.includes('/v1/prices?')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: [{
                        id: 'price_bundle2999',
                        active: true,
                        currency: 'usd',
                        unit_amount: 2999,
                    }],
                }),
            };
        }
        stripeParameters = new URLSearchParams(options.body);
        return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_live_example' }),
        };
    };
    try {
        const response = responseRecorder();
        await createCheckoutSession(checkoutRequest({
            body: {
                items: [{
                    id: 'independent-news-supporter-bundle',
                    variant: 'complete-five-sticker-set',
                    quantity: 1,
                }],
            },
        }), response);
        assert.equal(response.statusCode, 200);
        assert.equal(requests.length, 2);
        assert.match(requests[0].url, /independent_news_supporter_bundle_v3/);
        assert.equal(stripeParameters.get('line_items[0][price]'), 'price_bundle2999');
        assert.equal(stripeParameters.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '199');
        assert.equal(stripeParameters.get('metadata[catalog_version]'), 'sticker-drop-8');
    } finally {
        global.fetch = previousFetch;
    }
});

test('supporter bundle creates a reusable Stripe product and price when not configured yet', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    delete process.env.STRIPE_PRICE_SUPPORTER_BUNDLE;
    const previousFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.includes('/v1/prices?')) {
            return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        if (url.endsWith('/v1/prices')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id: 'price_createdbundle',
                    active: true,
                    currency: 'usd',
                    unit_amount: 2999,
                }),
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_live_bundle_created' }),
        };
    };
    try {
        const response = responseRecorder();
        await createCheckoutSession(checkoutRequest({
            body: {
                items: [{
                    id: 'independent-news-supporter-bundle',
                    variant: 'complete-five-sticker-set',
                    quantity: 1,
                }],
            },
        }), response);
        assert.equal(response.statusCode, 200);
        assert.equal(requests.length, 3);
        const createPriceParameters = new URLSearchParams(requests[1].options.body);
        assert.equal(createPriceParameters.get('unit_amount'), '2999');
        assert.equal(createPriceParameters.get('lookup_key'), 'independent_news_supporter_bundle_v3');
        assert.equal(createPriceParameters.get('product_data[name]'), 'Independent News Supporter Bundle - All Four Colorways + 4-Inch Stay Classy');
        const checkoutParameters = new URLSearchParams(requests[2].options.body);
        assert.equal(checkoutParameters.get('line_items[0][price]'), 'price_createdbundle');
        assert.equal(checkoutParameters.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '199');
    } finally {
        global.fetch = previousFetch;
        process.env.STRIPE_PRICE_SUPPORTER_BUNDLE = 'price_bundle';
    }
});

test('selected two-inch color is included in the Stripe receipt product name', { concurrency: false }, async () => {
    configureCheckoutEnvironment();
    const previousFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.includes('/v1/prices?')) {
            return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        if (url.endsWith('/v1/prices')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id: 'price_goldreceipt',
                    active: true,
                    currency: 'usd',
                    unit_amount: 600,
                }),
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_live_color_receipt' }),
        };
    };
    try {
        const response = responseRecorder();
        await createCheckoutSession(checkoutRequest({
            body: {
                items: [{ id: 'sticker-2-inch', variant: 'gold-holographic', quantity: 1 }],
            },
        }), response);
        assert.equal(response.statusCode, 200);
        assert.equal(requests.length, 3);
        const createPriceParameters = new URLSearchParams(requests[1].options.body);
        assert.equal(createPriceParameters.get('lookup_key'), 'chris_cerney_2in_gold_holographic_v1');
        assert.equal(createPriceParameters.get('product_data[name]'), '2-Inch Chris Cerney Sticker - Gold Holographic');
        const checkoutParameters = new URLSearchParams(requests[2].options.body);
        assert.equal(checkoutParameters.get('line_items[0][price]'), 'price_goldreceipt');
        assert.equal(checkoutParameters.get('metadata[item_details]'), '2-Inch Chris Cerney Sticker - Gold Holographic x1');
        assert.equal(checkoutParameters.get('payment_intent_data[metadata][item_details]'), '2-Inch Chris Cerney Sticker - Gold Holographic x1');
    } finally {
        global.fetch = previousFetch;
    }
});

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
        await createCheckoutSession(checkoutRequest(), response);
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
            metadata: { catalog_version: 'sticker-drop-5' },
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

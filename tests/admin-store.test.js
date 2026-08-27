'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const adminAuth = require('../api/admin-auth');
const adminStore = require('../api/admin-store');

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

function passwordHash(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function configureAdmin(password) {
    process.env.ADMIN_PASSWORD_HASH = passwordHash(password);
    process.env.ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
    process.env.STRIPE_SECRET_KEY = 'sk_test_admin';
    process.env.SITE_URL = 'https://www.chriscerney.org';
}

async function login(password) {
    const response = responseRecorder();
    await adminAuth({
        method: 'POST',
        headers: {
            origin: 'https://www.chriscerney.org',
            'content-type': 'application/json',
            'user-agent': 'test-browser',
        },
        body: { password },
        socket: { remoteAddress: '127.0.0.1' },
    }, response);
    return response;
}

test('admin login uses a secure server-side session cookie', { concurrency: false }, async () => {
    const password = 'correct horse battery staple 2026';
    configureAdmin(password);

    const invalid = await login('this password is incorrect');
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.headers['set-cookie'], undefined);

    const valid = await login(password);
    assert.equal(valid.statusCode, 200);
    assert.match(valid.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(valid.headers['set-cookie'], new RegExp(password));
});

test('admin sales totals include exact colors and bundle inventory consumption', { concurrency: false }, async () => {
    const password = 'another long administrator password';
    configureAdmin(password);
    const authenticated = await login(password);
    const cookie = authenticated.headers['set-cookie'].split(';')[0];
    const previousFetch = global.fetch;
    global.fetch = async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/v1/checkout/sessions') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    has_more: false,
                    data: [
                        {
                            id: 'cs_live_directsale123456789012345',
                            mode: 'payment',
                            status: 'complete',
                            payment_status: 'paid',
                            created: 1787520000,
                            amount_total: 1899,
                            amount_subtotal: 1800,
                            shipping_cost: { amount_total: 99 },
                            metadata: { item_selections: 'sticker-2-inch:black-gold-holographic:2|sticker-2-inch:coastal-blue:1' },
                            payment_intent: { latest_charge: { amount_refunded: 0, balance_transaction: { fee: 85, net: 1814 } } },
                        },
                        {
                            id: 'cs_live_a1HIokPmCZ67H6elTp8WC2xsyH6OK7Bk0el9GNWcEKlsAzx0I5T3f4mfiE',
                            mode: 'payment',
                            status: 'complete',
                            payment_status: 'paid',
                            created: 1787510000,
                            amount_total: 3198,
                            amount_subtotal: 2999,
                            shipping_cost: { amount_total: 199 },
                            metadata: { item_selections: 'independent-news-supporter-bundle:complete-five-sticker-set:1' },
                            payment_intent: { latest_charge: { amount_refunded: 0, balance_transaction: { fee: 123, net: 3075 } } },
                        },
                        {
                            id: 'cs_live_newbundlesale1234567890123',
                            mode: 'payment',
                            status: 'complete',
                            payment_status: 'paid',
                            created: 1787530000,
                            amount_total: 3198,
                            amount_subtotal: 2999,
                            shipping_cost: { amount_total: 199 },
                            metadata: { item_selections: 'independent-news-supporter-bundle:complete-four-sticker-set:1' },
                            payment_intent: { latest_charge: { amount_refunded: 0, balance_transaction: { fee: 123, net: 3075 } } },
                        },
                    ],
                }),
            };
        }
        if (parsed.pathname === '/v1/products') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ has_more: false, data: [] }),
            };
        }
        throw new Error(`Unexpected Stripe request: ${url}`);
    };

    try {
        const response = responseRecorder();
        await adminStore({
            method: 'GET',
            headers: { cookie, 'user-agent': 'test-browser' },
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.summary.orders, 3);
        assert.equal(response.body.summary.bundleUnits, 2);
        assert.equal(response.body.summary.totalCollected, 8295);
        const blackGold = response.body.inventory.items.find((item) => item.sku === 'sticker-2-inch:black-gold-holographic');
        const coastalBlue = response.body.inventory.items.find((item) => item.sku === 'sticker-2-inch:coastal-blue');
        const fourInch = response.body.inventory.items.find((item) => item.sku === 'sticker-4-inch:stay-classy');
        assert.deepEqual(
            { direct: blackGold.directSold, bundle: blackGold.bundleSold, used: blackGold.totalUsed },
            { direct: 2, bundle: 1, used: 3 },
        );
        assert.deepEqual(
            { direct: coastalBlue.directSold, bundle: coastalBlue.bundleSold, used: coastalBlue.totalUsed },
            { direct: 1, bundle: 2, used: 3 },
        );
        assert.equal(fourInch.totalUsed, 2);
        assert.equal(response.body.summary.legacyUnspecified, 0);
        assert.deepEqual(
            response.body.recentOrders.map((order) => ({ number: order.orderNumber, status: order.fulfillmentStatus })),
            [
                { number: 1, status: 'in_shipment' },
                { number: 2, status: 'waiting_inventory' },
                { number: 3, status: 'waiting_inventory' },
            ],
        );
    } finally {
        global.fetch = previousFetch;
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { salesCsv } = require('../api/merch-sales-feed');

test('sales feed contains aggregate counts without order or customer data', () => {
    const csv = salesCsv({
        generatedAt: '2026-08-24T12:00:00.000Z',
        totals: { bundleUnits: 8, orders: 41 },
        items: [{
            sku: 'sticker-2-inch:black-gold-holographic',
            name: '2-Inch Black and Gold Holographic',
            directSold: 30,
            bundleSold: 8,
            totalUsed: 38,
        }],
        recentOrders: [{ email: 'private@example.com', address: 'private' }],
    });

    assert.match(csv, /sticker-2-inch:black-gold-holographic/);
    assert.match(csv, /,30,8,38,/);
    assert.match(csv, /summary:paid-orders,Paid orders,0,0,41,/);
    assert.doesNotMatch(csv, /private@example\.com|address/i);
});

test('sales feed escapes CSV-special item names', () => {
    const csv = salesCsv({
        generatedAt: '2026-08-24T12:00:00.000Z',
        totals: { bundleUnits: 0, orders: 1 },
        items: [{ sku: 'sku', name: 'Gold, "Special"', directSold: 1, bundleSold: 0, totalUsed: 1 }],
    });
    assert.match(csv, /"Gold, ""Special"""/);
});

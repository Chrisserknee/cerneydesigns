'use strict';

const { getSales } = require('./_lib/stripe-store');
const { bundle } = require('./_lib/store-catalog');

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function salesCsv(sales) {
    const rows = [
        ['sku', 'item', 'direct_sold', 'bundle_sold', 'total_sold', 'updated_at'],
        ...sales.items.map((item) => [
            item.sku,
            item.name,
            item.directSold,
            item.bundleSold,
            item.totalUsed,
            sales.generatedAt,
        ]),
        [
            bundle.sku,
            'Independent News Supporter Bundle',
            sales.totals.bundleUnits,
            0,
            sales.totals.bundleUnits,
            sales.generatedAt,
        ],
        [
            'summary:paid-orders',
            'Paid orders',
            0,
            0,
            sales.totals.orders,
            sales.generatedAt,
        ],
    ];
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

module.exports = async function merchSalesFeed(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).send('Method not allowed');
    }

    try {
        const sales = await getSales();
        response.setHeader('Content-Type', 'text/csv; charset=utf-8');
        response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        return response.status(200).send(salesCsv(sales));
    } catch (error) {
        console.error('Merchandise sales feed failed', { name: error?.name, status: error?.status, code: error?.code });
        response.setHeader('Cache-Control', 'no-store');
        return response.status(503).send('Sales feed temporarily unavailable');
    }
};

module.exports.salesCsv = salesCsv;

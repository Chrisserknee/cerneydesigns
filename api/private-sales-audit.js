'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const AUTH_TOKEN_HASH = 'deda480a2abae314dee90b633d0da5059c99f395153690b8dbf5f7130c8ef43c';
const COLOR_NAMES = {
    'black-gold-holographic': 'Black and Gold Holographic',
    'gold-holographic': 'Gold Holographic',
    'coastal-blue': 'Coastal Blue',
    'silver-holographic': 'Silver Holographic',
};
const BUNDLE_COLORS = {
    'black-gold-gold-coastal': ['black-gold-holographic', 'gold-holographic', 'coastal-blue'],
    'black-gold-gold-silver': ['black-gold-holographic', 'gold-holographic', 'silver-holographic'],
    'black-gold-coastal-silver': ['black-gold-holographic', 'coastal-blue', 'silver-holographic'],
    'gold-coastal-silver': ['gold-holographic', 'coastal-blue', 'silver-holographic'],
    'complete-five-sticker-set': Object.keys(COLOR_NAMES),
};

function sendJson(response, status, body) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(status).json(body);
}

function isAuthorized(request) {
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const actualHash = createHash('sha256').update(token).digest();
    const expectedHash = Buffer.from(AUTH_TOKEN_HASH, 'hex');
    return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

async function listCompletedSessions(secretKey) {
    const sessions = [];
    let startingAfter = '';
    for (let page = 0; page < 50; page += 1) {
        const query = new URLSearchParams({ limit: '100', status: 'complete' });
        if (startingAfter) query.set('starting_after', startingAfter);
        const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions?${query}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(15000),
        });
        const body = await stripeResponse.json();
        if (!stripeResponse.ok || !Array.isArray(body.data)) {
            throw new Error(`Stripe session list failed with status ${stripeResponse.status}`);
        }
        sessions.push(...body.data);
        if (!body.has_more || body.data.length === 0) return sessions;
        startingAfter = body.data.at(-1).id;
    }
    throw new Error('Stripe session audit exceeded the pagination limit');
}

function emptyColorCounts() {
    return Object.fromEntries(Object.keys(COLOR_NAMES).map((key) => [key, 0]));
}

function parseSelection(selection) {
    const [id, variant, quantityText, ...extra] = selection.split(':');
    const quantity = Number(quantityText);
    if (extra.length > 0 || !id || !variant || !Number.isInteger(quantity) || quantity < 1) return null;
    return { id, variant, quantity };
}

function aggregateSessions(sessions) {
    const directUnits = emptyColorCounts();
    const bundleUnits = emptyColorCounts();
    const ordersContainingColor = emptyColorCounts();
    let siteOrders = 0;
    let siteGrossCents = 0;
    let bundleCount = 0;
    let standaloneFourInchUnits = 0;
    let malformedSiteOrders = 0;

    sessions.filter((session) => session.payment_status === 'paid').forEach((session) => {
        const encoded = String(session.metadata?.item_selections || '');
        if (!encoded) return;
        const selections = encoded.split('|').map(parseSelection);
        if (selections.some((selection) => !selection)) {
            malformedSiteOrders += 1;
            return;
        }

        siteOrders += 1;
        siteGrossCents += Number.isInteger(session.amount_total) ? session.amount_total : 0;
        const colorsInOrder = new Set();

        selections.forEach(({ id, variant, quantity }) => {
            if (id === 'sticker-2-inch' && Object.hasOwn(COLOR_NAMES, variant)) {
                directUnits[variant] += quantity;
                colorsInOrder.add(variant);
            } else if (id === 'sticker-4-inch' && variant === 'stay-classy') {
                standaloneFourInchUnits += quantity;
            } else if (id === 'independent-news-supporter-bundle' && Object.hasOwn(BUNDLE_COLORS, variant)) {
                bundleCount += quantity;
                BUNDLE_COLORS[variant].forEach((color) => {
                    bundleUnits[color] += quantity;
                    colorsInOrder.add(color);
                });
            }
        });

        colorsInOrder.forEach((color) => {
            ordersContainingColor[color] += 1;
        });
    });

    const colors = Object.fromEntries(Object.entries(COLOR_NAMES).map(([key, name]) => [key, {
        name,
        directUnits: directUnits[key],
        bundleUnits: bundleUnits[key],
        totalUnitsToFulfill: directUnits[key] + bundleUnits[key],
        ordersContainingColor: ordersContainingColor[key],
    }]));

    return {
        siteOrders,
        siteGrossCents,
        bundleCount,
        standaloneFourInchUnits,
        totalFourInchUnitsToFulfill: standaloneFourInchUnits + bundleCount,
        malformedSiteOrders,
        colors,
    };
}

module.exports = async function privateSalesAudit(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }
    if (!isAuthorized(request)) return sendJson(response, 401, { error: 'Unauthorized.' });

    const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secretKey) return sendJson(response, 503, { error: 'Sales audit is not configured.' });

    try {
        const sessions = await listCompletedSessions(secretKey);
        return sendJson(response, 200, {
            generatedAt: new Date().toISOString(),
            completedSessionsScanned: sessions.length,
            ...aggregateSessions(sessions),
        });
    } catch (error) {
        console.error('Private sales audit failed', { name: error?.name, message: error?.message });
        return sendJson(response, 502, { error: 'Sales audit is temporarily unavailable.' });
    }
};

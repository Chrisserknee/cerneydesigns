'use strict';

const { isAuthenticated } = require('./_lib/admin-auth');
const { bodyIsTooLarge, isAllowedOrigin, parseBody, sendJson } = require('./_lib/http');
const { getInventorySnapshot, saveInventoryCounts, validateInventoryCounts } = require('./_lib/stripe-store');

function adminResponse(snapshot) {
    const { sales, inventory } = snapshot;
    return {
        generatedAt: sales.generatedAt,
        summary: {
            orders: sales.totals.orders,
            totalCollected: sales.totals.total,
            productRevenue: sales.totals.subtotal,
            shippingCollected: sales.totals.shipping,
            refunded: sales.totals.refunded,
            stripeFees: sales.totals.fee,
            net: sales.totals.net,
            bundleUnits: sales.totals.bundleUnits,
            legacyUnspecified: sales.totals.legacyUnspecified,
        },
        inventory: {
            tracking: inventory.tracking,
            fullyTracked: inventory.fullyTracked,
            updatedAt: inventory.updatedAt,
            bundle: inventory.bundle,
            items: inventory.items,
        },
        recentOrders: sales.recentOrders.map((order) => ({
            orderNumber: order.orderNumber,
            created: order.created,
            customerName: order.customerName,
            fulfillmentStatus: order.fulfillmentStatus,
            amount: order.amount,
            refunded: order.refunded,
            items: order.items,
        })),
    };
}

module.exports = async function adminStore(request, response) {
    if (!isAuthenticated(request)) return sendJson(response, 401, { error: 'Administrator login required.' });

    if (request.method === 'GET') {
        try {
            return sendJson(response, 200, adminResponse(await getInventorySnapshot()));
        } catch (error) {
            console.error('Admin store read failed', { name: error?.name, status: error?.status, code: error?.code });
            return sendJson(response, 502, { error: 'Store data is temporarily unavailable.' });
        }
    }

    if (request.method !== 'PUT') {
        response.setHeader('Allow', 'GET, PUT');
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }
    if (!isAllowedOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(response, 415, { error: 'JSON request required.' });
    }
    if (bodyIsTooLarge(request, 8192)) return sendJson(response, 413, { error: 'Request is too large.' });

    let body;
    try {
        body = parseBody(request);
    } catch {
        return sendJson(response, 400, { error: 'Invalid JSON.' });
    }
    const counts = validateInventoryCounts(body?.inventory);
    if (!counts) return sendJson(response, 400, { error: 'Enter a valid on-hand count for every sticker.' });

    try {
        return sendJson(response, 200, adminResponse(await saveInventoryCounts(counts)));
    } catch (error) {
        console.error('Admin inventory update failed', { name: error?.name, status: error?.status, code: error?.code });
        return sendJson(response, 502, { error: 'Inventory could not be saved. No storefront changes were made.' });
    }
};

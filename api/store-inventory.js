'use strict';

const { sendJson } = require('./_lib/http');
const { getInventorySnapshot, publicInventory } = require('./_lib/stripe-store');

module.exports = async function storeInventory(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }
    try {
        const inventory = publicInventory(await getInventorySnapshot());
        return sendJson(response, 200, inventory, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
    } catch (error) {
        console.error('Public inventory read failed', { name: error?.name, status: error?.status, code: error?.code });
        return sendJson(response, 200, { tracking: false, variants: {}, bundle: { tracked: false, available: true, remaining: null } }, 'public, max-age=10');
    }
};

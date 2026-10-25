'use strict';

const { isAuthenticated } = require('./_lib/admin-auth');
const { bodyIsTooLarge, parseBody, sendJson } = require('./_lib/http');
const { COOKIE_NAME, SpotlightError, config, createService, createStripe, sameOrigin } = require('./_lib/spotlight');

function createHandler({ makeStripe = createStripe, getConfig = config, authenticateAdmin = isAuthenticated } = {}) {
    return async function spotlight(request, response) {
        const settings = getConfig();
        if (!['GET', 'POST'].includes(request.method)) {
            response.setHeader('Allow', 'GET, POST');
            return sendJson(response, 405, { error: 'Method not allowed.' });
        }
        try {
            if (request.method === 'GET') {
                const service = createService(settings.secret ? makeStripe(settings) : null, settings);
                return sendJson(response, 200, await service.directory());
            }
            if (!sameOrigin(request, settings)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
            if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'JSON request required.' });
            if (bodyIsTooLarge(request, 8192)) return sendJson(response, 413, { error: 'Request is too large.' });
            let body;
            try { body = parseBody(request); }
            catch { return sendJson(response, 400, { error: 'Invalid JSON.' }); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'Invalid request.' });
            if (body.op === 'logout') {
                response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
                return sendJson(response, 200, { status: 'none', canManage: false, published: false });
            }
            if (['admin-list', 'admin-update'].includes(body.op) && !authenticateAdmin(request)) return sendJson(response, 401, { error: 'Administrator login required.' });
            if (!settings.secret) return sendJson(response, 503, { error: 'Spotlight is not configured yet.', code: 'CHECKOUT_DISABLED' });
            const service = createService(makeStripe(settings), settings);
            let result;
            if (body.op === 'checkout') result = await service.checkout(request, response, body);
            else if (body.op === 'status') result = await service.status(request, response);
            else if (body.op === 'portal') result = await service.portal(request);
            else if (body.op === 'update') result = await service.update(request, body);
            else if (['member-options', 'member-request', 'member-checkout', 'member-orders', 'member-cancel'].includes(body.op)) result = await service.memberExtras(request, body);
            else if (body.op === 'admin-list') result = await service.adminList();
            else if (body.op === 'admin-update') result = await service.adminUpdate(body);
            else return sendJson(response, 400, { error: 'Unknown Spotlight operation.' });
            return sendJson(response, 200, result);
        } catch (error) {
            if (error instanceof SpotlightError) return sendJson(response, error.status, { error: error.message, code: error.code });
            console.error('Spotlight request failed', { name: error?.name, type: error?.type, code: error?.code });
            return sendJson(response, 502, { error: 'Spotlight is temporarily unavailable. Please try again.', code: 'STRIPE_UNAVAILABLE' });
        }
    };
}

const directoryHandler = createHandler();
const logoHandler = require('./_lib/spotlight-handlers/logo');
const reviewHandler = require('./_lib/spotlight-handlers/review');
// Share one serverless function while preserving each handler's own validation.
module.exports = (request, response) => {
    const handler = new URL(request.url || '/', 'https://cerneyselects.com').searchParams.get('handler');
    if (handler === 'booking') return require('./_lib/booking-handler')(request, response);
    if (handler === 'logo') return logoHandler(request, response);
    if (handler === 'review') return reviewHandler(request, response);
    if (handler) return sendJson(response, 404, { error: 'Not found.' });
    return directoryHandler(request, response);
};
module.exports.createHandler = createHandler;

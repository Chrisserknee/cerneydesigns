'use strict';

const { bodyIsTooLarge, parseBody, sendJson } = require('../http');
const { config, sameOrigin } = require('../spotlight');
const { callModeration } = require('../spotlight-moderation');

function createHandler({ call = callModeration, getConfig = config } = {}) {
    return async (request, response) => {
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST');
            return sendJson(response, 405, { error: 'Open your review email to review a listing.' });
        }
        if (!sameOrigin(request, getConfig())) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
        if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'JSON request required.' });
        if (bodyIsTooLarge(request, 4096)) return sendJson(response, 413, { error: 'Request is too large.' });
        let body;
        try { body = parseBody(request); } catch { return sendJson(response, 400, { error: 'Invalid JSON.' }); }
        if (!body || !['review', 'decide'].includes(body.op) || typeof body.token !== 'string' || body.token.length > 2000 || body.token.length < 30) return sendJson(response, 400, { error: 'Use the secure link from your review email.' });
        if (body.op === 'decide' && (!['approve', 'decline'].includes(body.decision) || body.confirmed !== true)) return sendJson(response, 400, { error: 'Confirm your review decision.' });
        if (body.op === 'decide' && body.decision === 'decline' && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500 || /[\u0000-\u001f\u007f<>]/.test(body.reason))) return sendJson(response, 400, { error: 'Enter a plain-text decline reason, up to 500 characters.' });
        try {
            const payload = { token: body.token, ...(body.op === 'decide' ? { decision: body.decision, reason: body.decision === 'decline' ? body.reason.trim() : '', confirmed: true } : {}) };
            return sendJson(response, 200, await call(body.op, payload));
        } catch (error) {
            const status = [400, 401, 403, 404, 409, 410, 422, 429, 503].includes(error.status) ? error.status : 502;
            return sendJson(response, status, { error: status === 502 ? 'Review is temporarily unavailable. Please try again.' : error.message, code: error.code || 'REVIEW_UNAVAILABLE' });
        }
    };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

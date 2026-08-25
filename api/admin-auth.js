'use strict';

const {
    clearSessionCookie,
    isAuthenticated,
    isConfigured,
    loginAllowed,
    recordLogin,
    setSessionCookie,
    verifyPassword,
} = require('./_lib/admin-auth');
const { bodyIsTooLarge, isAllowedOrigin, parseBody, sendJson } = require('./_lib/http');

module.exports = async function adminAuth(request, response) {
    if (request.method === 'GET') {
        return sendJson(response, 200, { configured: isConfigured(), authenticated: isAuthenticated(request) });
    }

    if (request.method === 'DELETE') {
        if (!isAllowedOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
        clearSessionCookie(response);
        return sendJson(response, 200, { authenticated: false });
    }

    if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST, DELETE');
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }
    if (!isConfigured()) return sendJson(response, 503, { error: 'Administrator access is not configured.' });
    if (!isAllowedOrigin(request)) return sendJson(response, 403, { error: 'Request origin is not allowed.' });
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(response, 415, { error: 'JSON request required.' });
    }
    if (bodyIsTooLarge(request, 4096)) return sendJson(response, 413, { error: 'Request is too large.' });
    if (!loginAllowed(request)) return sendJson(response, 429, { error: 'Too many attempts. Try again later.' });

    let body;
    try {
        body = parseBody(request);
    } catch {
        return sendJson(response, 400, { error: 'Invalid JSON.' });
    }
    const valid = verifyPassword(body?.password);
    recordLogin(request, valid);
    if (!valid) return sendJson(response, 401, { error: 'Incorrect password.' });
    setSessionCookie(response, request);
    return sendJson(response, 200, { configured: true, authenticated: true });
};

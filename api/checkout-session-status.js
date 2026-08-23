'use strict';

const CATALOG_VERSION = 'sticker-drop-7';

function sendJson(response, status, body) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(status).json(body);
}

module.exports = async function checkoutSessionStatus(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
    }

    const sessionId = String(request.query?.session_id || '').trim();
    if (!/^cs_(?:test|live)_[A-Za-z0-9]{20,}$/.test(sessionId)) {
        return sendJson(response, 400, { error: 'Invalid checkout session.', code: 'INVALID_SESSION' });
    }

    const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secretKey) {
        return sendJson(response, 503, { error: 'Checkout verification is not configured.', code: 'NOT_CONFIGURED' });
    }

    try {
        const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(12000),
        });
        const session = await stripeResponse.json();

        if (!stripeResponse.ok) {
            console.error('Stripe Checkout verification failed', {
                status: stripeResponse.status,
                type: session?.error?.type,
                code: session?.error?.code,
            });
            return sendJson(response, 502, { error: 'Payment could not be verified.', code: 'STRIPE_ERROR' });
        }

        const confirmed = session.mode === 'payment'
            && session.status === 'complete'
            && session.payment_status === 'paid'
            && session.metadata?.catalog_version === CATALOG_VERSION;

        return sendJson(response, 200, { confirmed });
    } catch (error) {
        console.error('Stripe Checkout verification request failed', { name: error?.name });
        return sendJson(response, 502, { error: 'Payment could not be verified.', code: 'STRIPE_UNAVAILABLE' });
    }
};

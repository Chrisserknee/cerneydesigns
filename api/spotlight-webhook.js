'use strict';

const { sendJson } = require('./_lib/http');
const { config, createService, createStripe } = require('./_lib/spotlight');
const MAX_WEBHOOK_BYTES = 256 * 1024;

async function rawBody(request) {
    if (Number(request.headers?.['content-length'] || 0) > MAX_WEBHOOK_BYTES) throw new Error('Body too large');
    // Plain Vercel Node functions expose a lazy JSON-parsing body getter. Reading it
    // destroys the exact-byte contract. The preserved IncomingMessage stream must
    // always win, even when the runtime also supplies a parsed request.body.
    if (typeof request[Symbol.asyncIterator] === 'function') {
        let total = 0;
        const chunks = [];
        for await (const chunk of request) {
            total += Buffer.byteLength(chunk);
            if (total > MAX_WEBHOOK_BYTES) throw new Error('Body too large');
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    // Raw-buffer adapters/test fixtures are supported. Parsed objects are never
    // serialized back to JSON because that cannot preserve a Stripe signature.
    if (Buffer.isBuffer(request.body)) {
        if (request.body.length > MAX_WEBHOOK_BYTES) throw new Error('Body too large');
        return request.body;
    }
    if (typeof request.body === 'string') {
        if (Buffer.byteLength(request.body) > MAX_WEBHOOK_BYTES) throw new Error('Body too large');
        return Buffer.from(request.body, 'utf8');
    }
    throw new Error('Raw body required');
}

function createHandler({ makeStripe = createStripe, getConfig = config } = {}) {
    return async function spotlightWebhook(request, response) {
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST');
            return sendJson(response, 405, { error: 'Method not allowed.' });
        }
        const settings = getConfig();
        if (!settings.secret || !settings.webhookSecret) return sendJson(response, 503, { error: 'Webhook is not configured.' });
        const stripe = makeStripe(settings);
        let event;
        try { event = stripe.webhooks.constructEvent(await rawBody(request), request.headers?.['stripe-signature'], settings.webhookSecret); }
        catch { return sendJson(response, 400, { error: 'Invalid webhook signature or body.' }); }
        try {
            await createService(stripe, settings).webhook(event);
            return sendJson(response, 200, { received: true });
        } catch (error) {
            console.error('Spotlight webhook failed', { name: error?.name, type: error?.type, code: error?.code });
            // Stripe retries failed deliveries; never acknowledge a failed state refresh.
            return sendJson(response, 500, { error: 'Webhook processing failed.' });
        }
    };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.rawBody = rawBody;

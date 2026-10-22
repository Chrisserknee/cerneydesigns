'use strict';

const { createHmac, createHash, timingSafeEqual, randomUUID, randomBytes } = require('node:crypto');
const { APPLICATION_ID } = require('./storage');
const fail = (message, code = 'INVALID_REQUEST', status = 409) => { throw Object.assign(new Error(message), { status, code }); };
const clean = (value, max) => typeof value === 'string' && value.trim().length <= max && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : '';
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const slotId = specialty => `sub_${createHash('sha256').update(`monterey-county:${specialty}`).digest('hex')}`;
const canonicalSpecialty = value => clean(value, 80).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function createMemberBilling({ store, slots, payments, settings, now = Date.now }) {
    async function change(target, key, edit) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const current = await target.read(key);
            if (!current) fail('Request not found.', 'NOT_FOUND', 404);
            const next = structuredClone(current);
            if (edit(next) === false) return current;
            next.revision++; next.updatedAt = now();
            if (await target.compareAndSwap(key, current.revision, next)) return next;
        }
        fail('Please retry shortly.', 'RETRY_LATER', 503);
    }
    function tokenFor(base, request) {
        if (!settings.reviewSecret || settings.reviewSecret.length < 32) return '';
        const data = Buffer.from(JSON.stringify({ v: 1, base, request: request.id, nonce: request.reviewNonce, exp: request.reviewExpiresAt })).toString('base64url');
        return `${data}.${createHmac('sha256', settings.reviewSecret).update(`member-review:${data}`).digest('base64url')}`;
    }
    async function authenticate(token) {
        if (typeof token !== 'string' || token.length > 2000 || !settings.reviewSecret) fail('Invalid review link.', 'INVALID_TOKEN', 403);
        const [body, signature, extra] = token.split('.');
        const expected = createHmac('sha256', settings.reviewSecret).update(`member-review:${body}`).digest('base64url');
        if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail('Invalid review link.', 'INVALID_TOKEN', 403);
        let data; try { data = JSON.parse(Buffer.from(body, 'base64url')); } catch { fail('Invalid review link.', 'INVALID_TOKEN', 403); }
        if (data.v !== 1 || !APPLICATION_ID.test(data.base || '') || !uuid(data.request) || !Number.isSafeInteger(data.exp) || data.exp <= now()) fail('Review link expired.', 'INVALID_TOKEN', 403);
        const record = await store.read(data.base), request = record?.requests?.[data.request];
        if (!request || request.reviewNonce !== data.nonce || request.reviewExpiresAt !== data.exp) fail('Invalid review link.', 'INVALID_TOKEN', 403);
        return { base: data.base, record, request };
    }
    function prepare(base, request, snapshot) {
        Object.assign(request, { snapshot, reviewNonce: randomBytes(24).toString('hex'), reviewExpiresAt: now() + 30 * 86400000 });
        return `${settings.siteUrl}/spotlightreview/member.html#${tokenFor(base, request)}`;
    }
    function publicOrder(request) {
        return { id: request.id, offer: request.offer, quote: request.quote || null, billing: request.billing ? { state: request.billing.state, periodEnd: request.billing.periodEnd || null, minimumEnd: request.billing.minimumEnd || null, cancelAt: request.billing.cancelAt || null, cancellationRequested: !!request.billing.cancellationRequested } : null };
    }
    function queue(record, request, type, content) {
        const key = `${request.id}:${type}`;
        if (record.emails[key]) return;
        record.emails[key] = { state: 'queued', firstAttemptAt: 0, payload: { from: 'Cerney Selects <sponsorships@bookings.chriscerney.org>', to: type.startsWith('owner') ? settings.ownerEmail : request.snapshot.email, replyTo: settings.ownerEmail, subject: `Cerney Selects: ${request.snapshot.businessName}`, text: `${content}\n\nManage your request in the browser you used to join:\n${settings.siteUrl}/apply/#manage\n\nQuestions? Reply to this email.` } };
        record.work.state = 'queued'; record.work.nextAttemptAt = now();
    }
    async function review({ token }) {
        const { request } = await authenticate(token);
        const occupied = (await slots.listAll({ limit: 500 })).filter(s => s.owner).map(s => ({ specialty: s.specialty, state: s.state }));
        return { ...publicOrder(request), specialty: request.specialty, notes: request.notes, businessName: request.snapshot.businessName, area: 'Monterey County', occupied, purchasesEnabled: settings.billingEnabled === true };
    }
    async function quote(input) {
        const { base, request } = await authenticate(input.token);
        if (input.confirmed !== true || !uuid(input.decisionId)) fail('Confirm the quote details.');
        if (!['approve', 'decline'].includes(input.decision)) fail('Choose a decision.');
        const recurring = request.offer !== 'spotlight';
        const specialty = recurring ? clean(input.specialty, 80) : '';
        const key = canonicalSpecialty(specialty);
        const scope = clean(typeof input.scope === 'string' ? input.scope.replace(/\r\n?|\n/g, ' ') : input.scope, 800);
        const fingerprint = createHash('sha256').update(JSON.stringify([input.decision, specialty, scope, recurring ? 15000 : input.amount])).digest('hex');
        if (input.decision === 'approve' && ((!recurring && (!Number.isSafeInteger(input.amount) || input.amount < 100000 || input.amount > 1000000 || !scope)) || (recurring && key.length < 3))) fail('Agree a specific specialty or video scope and price.');
        // Quotes cannot alter a checkout already offered or a purchased service.
        const updated = await change(store, base, record => {
            const r = record.requests[request.id];
            if (r.quote?.decisionId === input.decisionId) {
                if (r.quote.fingerprint !== fingerprint) fail('Use a fresh quote confirmation.', 'ALREADY_STARTED');
                return false;
            }
            if (r.billing && !['expired', 'canceled'].includes(r.billing.state)) fail('A payment or service already exists for this request.', 'ALREADY_STARTED');
            const version = randomUUID();
            if (r.quote) {
                r.history ||= [];
                if (r.history.length >= 10) fail('This request history needs review.', 'CHECKOUT_ATTENTION');
                r.history.push({ quote: r.quote, billing: r.billing || null });
            }
            r.quote = { version, decisionId: input.decisionId, fingerprint, status: input.decision === 'approve' ? 'approved' : 'declined', specialty, specialtyKey: key, area: recurring ? 'Monterey County' : '', scope, amount: recurring ? 15000 : input.amount || 0, setup: r.offer === 'mustache' ? 50000 : 0, minimumMonths: r.offer === 'mustache' ? 3 : 0, expiresAt: now() + 7 * 86400000 };
            delete r.billing;
            const terms = recurring ? `$150/month in addition to your existing $100/month listing ($250/month total). ${r.offer === 'mustache' ? '$500 one-time setup and a three-month add-on minimum ($450), then monthly. Includes a one-minute video with Chris and monthly analytics.' : 'No setup fee. Month to month; cancel future renewals before the next billing date.'}\nFeatured specialty: ${specialty}, throughout Monterey County. Other ordinary listings remain welcome.` : `$${(r.quote.amount / 100).toFixed(2)} once.\nAgreed video scope: ${scope}`;
            queue(record, r, `quote-${version}`, input.decision === 'approve' ? `Chris has approved your quote.\n\n${terms}\n\nReview the full terms and choose to pay in your member page. This quote does not charge you or reserve availability. It expires in seven days.` : 'Chris has reviewed your request and cannot offer this service at this time. No payment has been taken. Reply to discuss alternatives.');
        });
        return publicOrder(updated.requests[request.id]);
    }
    async function reserve(base, request) {
        if (request.offer === 'spotlight') return;
        const key = slotId(request.quote.specialtyKey), owner = `${base}:${request.id}:${request.quote.version}`;
        await slots.create(key, { id: key, revision: 0, owner: '', specialty: request.quote.specialty, state: 'available' });
        await change(slots, key, slot => {
            if (slot.owner && slot.owner !== owner) fail('This featured specialty is no longer available.', 'SPECIALTY_UNAVAILABLE');
            if (slot.owner === owner) return false;
            slot.owner = owner; slot.specialty = request.quote.specialty; slot.state = 'reserved';
        });
    }
    async function setSlot(base, request, state) {
        if (request.offer === 'spotlight') return;
        const key = slotId(request.quote.specialtyKey), owner = `${base}:${request.id}:${request.quote.version}`;
        await change(slots, key, slot => {
            if (slot.owner !== owner) return false;
            slot.state = state;
            if (state === 'available') slot.owner = '';
        });
    }
    async function checkout({ subscriptionId: base, requestId, version, consent }) {
        if (settings.billingEnabled !== true) fail('Checkout is being prepared. No payment has been taken.', 'BILLING_DISABLED', 503);
        if (!APPLICATION_ID.test(base || '') || !uuid(requestId) || consent !== true) fail('Confirm your quote and payment terms.');
        const member = await payments.base(base);
        if (!member.continuing) fail('An approved, continuing paid membership is required.', 'PAID_MEMBER_REQUIRED', 403);
        const record = await change(store, base, record => {
            const r = record.requests[requestId];
            if (!r?.quote || r.quote.status !== 'approved' || r.quote.version !== version || r.quote.expiresAt <= now()) fail('This quote changed or expired. Ask Chris for a new quote.', 'QUOTE_EXPIRED');
            if (r.billing && r.billing.state !== 'checkout') fail('Refresh your existing payment status.', 'ALREADY_STARTED');
            if (r.billing && now() - r.billing.startedAt >= 23 * 3600000) fail('An uncertain checkout needs manual review.', 'CHECKOUT_ATTENTION');
            r.billing ||= { state: 'checkout', startedAt: now(), expiresAt: Math.floor(now() / 1000) + 3600, integration: Array.from(randomBytes(8), n => String.fromCharCode(97 + n % 26)).join(''), consentAt: now(), termsVersion: version };
            record.billingNextAttemptAt = now() + 60000;
        });
        const request = record.requests[requestId];
        if (now() - request.billing.startedAt >= 23 * 3600000) fail('This checkout needs review. No new payment was started.', 'CHECKOUT_ATTENTION');
        try { await reserve(base, request); }
        catch (error) {
            if (error.code === 'SPECIALTY_UNAVAILABLE') await change(store, base, r => {
                if (r.requests[requestId].quote.version === request.quote.version && !r.requests[requestId].billing?.sessionId) delete r.requests[requestId].billing;
            });
            throw error;
        }
        // Same persisted request and quote always use the same Stripe idempotency
        // key. An ambiguous response retains the slot until Stripe is reconciled.
        const session = await payments.checkout(base, request);
        if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(session.id || '') || !session.url || new URL(session.url).hostname !== 'checkout.stripe.com' || new URL(session.url).protocol !== 'https:') fail('Checkout needs review.', 'CHECKOUT_ATTENTION');
        await change(store, base, r => {
            if (r.requests[requestId]?.quote?.version !== request.quote.version) return false;
            r.requests[requestId].billing.sessionId = session.id;
        });
        return { url: session.url };
    }
    async function reconcile(base, requestId) {
        const record = await store.read(base), request = record?.requests?.[requestId];
        if (!request?.billing || !request.quote) return null;
        if (!request.billing.sessionId) {
            if (now() - request.billing.startedAt < 23 * 3600000) {
                await reserve(base, request);
                const session = await payments.checkout(base, request);
                await change(store, base, r => {
                    if (r.requests[requestId]?.quote?.version !== request.quote.version) return false;
                    r.requests[requestId].billing.sessionId = session.id;
                });
                return reconcile(base, requestId);
            }
            fail('An uncertain checkout needs manual review.', 'CHECKOUT_ATTENTION');
        }
        const result = await payments.inspect(base, request);
        let commitment = null;
        if (result.state === 'active' && request.offer === 'mustache' && !request.billing.minimumEnd) commitment = await payments.minimum(request, result);
        const effective = commitment ? { ...request, billing: { ...request.billing, ...commitment } } : request;
        if (result.subscription && (result.state === 'payment_review' || ((!result.member.continuing || request.billing.cancellationRequested) && !result.cancelAt))) await payments.cancel(effective, result);
        const state = result.state;
        if (request.offer !== 'spotlight') await setSlot(base, request, ['expired', 'canceled'].includes(state) ? 'available' : state === 'active' && result.member.paid ? 'active' : 'reserved');
        const updated = await change(store, base, r => {
            const current = r.requests[requestId];
            // A delayed reconciliation for an expired/canceled checkout must
            // never overwrite the replacement quote or its new payment.
            if (current?.quote?.version !== request.quote.version || current.billing?.sessionId !== request.billing.sessionId) return false;
            Object.assign(current.billing, commitment || {}, { state, subscriptionId: result.subscriptionId || null, periodEnd: result.periodEnd || null, cancelAt: result.cancelAt || null, verifiedAt: now(), visible: state === 'active' && result.member.paid });
            r.billingNextAttemptAt = now() + 300000;
            if (state === 'payment_review') {
                queue(r, current, `payment-review-${current.quote.version}`, 'Your member service needs payment review. Featured display is paused and further add-on collection is stopped. Reply to Chris before starting another payment. Your separate base listing is managed independently.');
                queue(r, current, `owner-payment-review-${current.quote.version}`, `Payment needs review for ${current.snapshot.businessName}. Service: ${current.offer}. Featured display is paused. Recurring add-on collection has been stopped without a final invoice. Contact the member before approving a replacement service.`);
            }
            if (['active', 'paid'].includes(state)) {
                queue(r, current, `paid-${current.quote.version}`, `Your payment is confirmed. ${current.offer === 'spotlight' ? 'Chris will contact you to schedule your agreed Spotlight video project.' : `Your featured specialty is ${current.quote.specialty}, throughout Monterey County. Your base listing remains a separate $100/month subscription; this add-on is $150/month.${current.offer === 'mustache' ? ' The $500 setup fee is paid once. Chris will coordinate the video and monthly reports.' : ''}`}\n\nYou can view the service and cancellation details in your member page.`);
                queue(r, current, `owner-paid-${current.quote.version}`, `Payment confirmed for ${current.snapshot.businessName}. Service: ${current.offer}. Specialty: ${current.quote.specialty || 'Not applicable'}. Agreed scope: ${current.quote.scope || 'Package deliverables'}. Coordinate any video production and monthly report delivery with this member. Their email is ${current.snapshot.email}.`);
            }
        });
        return publicOrder(updated.requests[requestId]);
    }
    async function cancel({ subscriptionId: base, requestId, confirmed }) {
        if (confirmed !== true || !APPLICATION_ID.test(base || '') || !uuid(requestId)) fail('Confirm cancellation.');
        const record = await store.read(base), request = record?.requests?.[requestId];
        if (!request?.billing?.sessionId || request.offer === 'spotlight') fail('This recurring service was not found.', 'NOT_FOUND', 404);
        const inspected = await payments.inspect(base, request);
        if (!inspected.subscription) fail('Payment has not completed yet.');
        if (inspected.state === 'canceled') return reconcile(base, requestId);
        let minimum = request.offer === 'mustache' && !request.billing.minimumEnd ? await payments.minimum(request, inspected) : {};
        await change(store, base, r => {
            if (r.requests[requestId]?.quote?.version !== request.quote.version) fail('This service changed. Refresh before canceling.', 'QUOTE_CHANGED');
            Object.assign(r.requests[requestId].billing, minimum, { cancellationRequested: true }); r.billingNextAttemptAt = now();
        });
        await payments.cancel({ ...request, billing: { ...request.billing, ...minimum } }, inspected);
        await reconcile(base, requestId);
        await change(store, base, r => queue(r, r.requests[requestId], `cancel-${request.quote.version}`, 'Your cancellation request is recorded. Future renewals stop at the end of your paid period, or at the end of the Mustache Stamp minimum term if that applies. Your member page shows the effective date. Your base listing is managed separately.'));
        return publicOrder((await store.read(base)).requests[requestId]);
    }
    async function orders({ subscriptionId: base }) {
        if (!APPLICATION_ID.test(base || '')) fail('Valid membership required.');
        let record = await store.read(base);
        for (const request of Object.values(record?.requests || {})) if (request.billing?.sessionId && !['expired', 'canceled'].includes(request.billing.state)) await reconcile(base, request.id);
        record = await store.read(base);
        return { orders: Object.values(record?.requests || {}).filter(r => r.quote || r.billing).map(publicOrder) };
    }
    async function entitlement({ subscriptionId: base }) {
        if (!APPLICATION_ID.test(base || '')) fail('Valid membership required.');
        const record = await store.read(base);
        const request = Object.values(record?.requests || {}).find(r => r.offer !== 'spotlight' && r.billing?.sessionId && !['expired', 'canceled'].includes(r.billing.state));
        if (!request) return null;
        await reconcile(base, request.id);
        const refreshed = (await store.read(base)).requests[request.id];
        const slot = await slots.read(slotId(refreshed.quote.specialtyKey));
        return refreshed.billing.visible && slot?.owner === `${base}:${request.id}:${request.quote.version}` && slot.state === 'active' ? { specialty: refreshed.quote.specialty, area: 'Monterey County', offer: request.offer } : null;
    }
    async function retry() {
        const records = await store.listAll({ limit: 500 });
        for (const record of records) {
            if (!record.billingNextAttemptAt || record.billingNextAttemptAt > now()) continue;
            for (const request of Object.values(record.requests || {})) {
                if (!request.billing || ['expired', 'canceled'].includes(request.billing.state)) continue;
                try { await reconcile(record.id, request.id); }
                catch { await change(store, record.id, r => { r.billingNextAttemptAt = now() + 300000; r.requests[request.id].billing.attention = true; }); }
            }
        }
    }
    return { prepare, review, quote, checkout, reconcile, cancel, orders, entitlement, retry, publicOrder };
}
module.exports = { createMemberBilling, canonicalSpecialty, slotId };

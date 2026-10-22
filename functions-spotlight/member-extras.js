'use strict';

const { randomUUID } = require('node:crypto');
const { APPLICATION_ID } = require('./storage');

// This is an enquiry workflow. A request never authorizes a charge, promises
// availability, reserves a specialty, or changes the member's subscription.
const OFFERS = Object.freeze([
    { id: 'mustache', name: 'The Mustache Stamp', price: '$250/month total + $500 one-time setup', detail: 'Your $100 listing continues, with an additional $150/month. Includes a one-minute video with Chris Cerney, monthly analytics, and one agreed exclusive featured specialty.', terms: 'Three-month minimum. Specialty and coverage area must be agreed and available.', action: 'Request availability', specialty: true },
    { id: 'featured', name: 'Featured specialty', price: 'Add $150/month · $250/month total', detail: 'An exclusive featured position in one agreed business specialty, without a video or video setup fee. Other businesses can still join the directory.', terms: 'Subject to availability. Coverage area and minimum term will be confirmed in your quote.', action: 'Request availability', specialty: true },
    { id: 'spotlight', name: 'The Cerney Spotlight', price: 'Starting at $1,000 per feature', detail: 'A creative two-minute social video with Chris, an Instagram collaboration, and social distribution.', terms: 'A separate one-time project. We agree the scope and final price before you pay.', action: 'Request a quote', specialty: false },
]);
const fail = (message, status = 400, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), { status, code }); };
const text = (value, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f<>]/.test(value) || (required && !value.trim())) fail('Check the request details.');
    return value.trim();
};

function createMemberExtras({ store, providers, settings, now = Date.now }) {
    async function change(id, edit) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const current = await store.read(id);
            if (!current) fail('Member record not found.', 404, 'NOT_FOUND');
            const next = structuredClone(current);
            if (edit(next) === false) return current;
            next.revision = current.revision + 1;
            next.updatedAt = now();
            if (await store.compareAndSwap(id, current.revision, next)) return next;
        }
        fail('Please try again in a moment.', 503, 'RETRY_LATER');
    }

    function response(record) {
        return { offers: OFFERS, requests: Object.values(record?.requests || {}).map(r => ({ id: r.id, offer: r.offer, specialty: r.specialty, area: r.area, notes: r.notes, createdAt: r.createdAt, status: 'requested', emailStatus: record.emails?.[`${r.id}:member`]?.state === 'sent' ? 'sent' : 'queued' })) };
    }

    async function status({ subscriptionId }) {
        if (!APPLICATION_ID.test(subscriptionId || '')) fail('Valid membership required.');
        return response(await store.read(subscriptionId));
    }

    function emailPayload(request, snapshot, type) {
        const offer = OFFERS.find(o => o.id === request.offer);
        const details = `${offer.name}\n${offer.price}\n${offer.terms}\n\nBusiness: ${snapshot.businessName}\nRequested specialty: ${request.specialty || 'Not applicable'}\nRequested coverage area: ${request.area || 'Not applicable'}\nNotes: ${request.notes || 'None'}\nReference: ${request.id}`;
        return {
            from: 'Cerney Selects <sponsorships@bookings.chriscerney.org>',
            to: type === 'owner' ? settings.ownerEmail || 'cerneymedia@gmail.com' : snapshot.email,
            replyTo: 'cerneymedia@gmail.com',
            subject: type === 'owner' ? `Cerney Selects member request: ${snapshot.businessName}` : `Your Cerney Selects request: ${offer.name}`,
            text: type === 'owner'
                ? `An existing paid member requested an optional service. This is an enquiry only: no extra charge, upgrade, or exclusive reservation has been made.\n\n${details}\n\nMember email: ${snapshot.email}\n\nConfirm the exact specialty, coverage area, availability, minimum term, and any project scope before sending a final quote. The customer must agree to the final quote before a separate payment. The $100 listing remains unchanged.`
                : `Thanks, ${snapshot.businessName}. We received your request. Chris will contact you to discuss availability and the details.\n\n${details}\n\nYou have not been charged for this request. It does not reserve an exclusive position or change your existing $100/month listing. You will receive a final quote to agree to before any additional payment.\n\nView your request in the browser you used to sign up:\n${settings.siteUrl.replace(/\/$/, '')}/apply/#manage\n\nYou can reply to this email with questions.\n\nChris`,
        };
    }

    async function request(input) {
        if (!APPLICATION_ID.test(input.subscriptionId || '')) fail('Valid membership required.');
        const offer = OFFERS.find(o => o.id === input.offer);
        if (!offer || input.consent !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId || '')) fail('Choose an option and confirm your request.');
        const notes = typeof input.notes === 'string' ? input.notes.replace(/\r\n?|\n/g, ' ') : input.notes;
        const request = { id: input.requestId.toLowerCase(), offer: offer.id, specialty: text(input.specialty || '', 100, offer.specialty), area: text(input.area || '', 100, offer.specialty), notes: text(notes || '', 800), createdAt: now() };
        const snapshot = { businessName: text(input.businessName, 100, true), email: text(input.email, 254, true) };
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.email)) fail('A verified billing email is required.');
        await store.create(input.subscriptionId, { id: input.subscriptionId, revision: 0, requests: {}, emails: {}, createdAt: now(), updatedAt: now(), work: { state: 'idle', leaseUntil: 0, nextAttemptAt: 0 } });
        await change(input.subscriptionId, record => {
            const duplicate = Object.values(record.requests).find(r => r.offer === offer.id || (offer.specialty && ['mustache', 'featured'].includes(r.offer)));
            if (duplicate) {
                if (duplicate.id === request.id && ['offer', 'specialty', 'area', 'notes'].every(k => duplicate[k] === request[k])) return false;
                fail('You already have a request for this option. Reply to your confirmation email to change it.', 409, 'EXISTING_REQUEST');
            }
            if (record.requests[request.id]) fail('Use a new request reference.', 409, 'EXISTING_REQUEST');
            record.requests[request.id] = request;
            for (const type of ['owner', 'member']) record.emails[`${request.id}:${type}`] = { state: 'queued', payload: emailPayload(request, snapshot, type), firstAttemptAt: 0 };
            record.work.state = 'queued'; record.work.nextAttemptAt = now();
        });
        await run(input.subscriptionId);
        return response(await store.read(input.subscriptionId));
    }

    async function run(id) {
        const leaseOwner = randomUUID();
        const claimed = await change(id, record => {
            if (!['queued', 'leased'].includes(record.work.state) || record.work.leaseUntil > now() || record.work.nextAttemptAt > now()) return false;
            Object.assign(record.work, { state: 'leased', leaseOwner, leaseUntil: now() + 120000 });
        });
        if (claimed.work.leaseOwner !== leaseOwner) return;
        try {
            if (!providers.emailReady()) fail('Email delivery is waiting for configuration.', 503, 'EMAIL_DISABLED');
            for (const key of Object.keys(claimed.emails)) {
                let record = await store.read(id);
                if (record.work.leaseOwner !== leaseOwner) return;
                if (record.emails[key].state === 'sent') continue;
                // Never automatically resend an uncertain delivery outside the
                // provider's 24-hour deduplication window.
                if (record.emails[key].firstAttemptAt && now() - record.emails[key].firstAttemptAt >= 23 * 3600000) fail('Email delivery needs manual review.', 503, 'EMAIL_ATTENTION');
                record = await change(id, r => {
                    if (r.work.leaseOwner !== leaseOwner) return false;
                    r.emails[key].firstAttemptAt ||= now(); r.work.leaseUntil = now() + 120000;
                });
                if (record.work.leaseOwner !== leaseOwner) return;
                const receipt = await providers.sendEmail(record.emails[key].payload, `selects-extras:${id}:${key}`);
                await change(id, r => { if (r.work.leaseOwner !== leaseOwner) return false; Object.assign(r.emails[key], { state: 'sent', receipt: receipt.id, sentAt: now() }); });
            }
            await change(id, r => {
                if (r.work.leaseOwner !== leaseOwner) return false;
                // A second request may have queued new email during this lease.
                Object.assign(r.work, { state: Object.values(r.emails).some(e => e.state !== 'sent') ? 'queued' : 'idle', leaseUntil: 0, leaseOwner: '', nextAttemptAt: now() });
            });
        } catch (error) {
            await change(id, r => {
                if (r.work.leaseOwner !== leaseOwner) return false;
                Object.assign(r.work, { state: error.code === 'EMAIL_ATTENTION' ? 'attention' : 'queued', leaseUntil: 0, leaseOwner: '', nextAttemptAt: now() + 300000, lastError: error.code === 'EMAIL_ATTENTION' ? 'EMAIL_ATTENTION' : 'EMAIL_RETRY' });
            });
        }
    }

    async function retry() {
        const due = await store.listDue({ now: now(), limit: 20 });
        for (const record of due) await run(record.id);
        return { processed: due.length };
    }
    return { status, request, retry };
}

module.exports = { createMemberExtras, OFFERS };

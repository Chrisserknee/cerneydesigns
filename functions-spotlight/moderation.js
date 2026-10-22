'use strict';

const crypto = require('node:crypto');
const { buildEmail } = require('./emails');
const { profileHash } = require('./providers');
const MAX_TOKEN_MS = 7 * 86400000;
function fail(message, status = 400, code = 'INVALID_REQUEST') { throw Object.assign(new Error(message), { status, code }); }
function attention(message, code = 'NEEDS_ATTENTION') { return Object.assign(new Error(message), { status: 409, code }); }
function idValid(value) { return /^sub_[A-Za-z0-9]+$/.test(value || ''); }

function createModeration({ store, providers, settings, banners, now = Date.now }) {
    const tokenSecret = String(settings.reviewSecret || '');
    if (tokenSecret.length < 32) fail('Review signing secret is not configured.', 503, 'RETRY_LATER');
    const leaseMs = Math.max(30000, Math.min(settings.leaseMs || 120000, 300000));
    const retryMs = Math.max(1000, settings.retryMs || 300000);
    const tokenTtl = Math.min(settings.reviewTokenTtlMs || MAX_TOKEN_MS, MAX_TOKEN_MS);
    const maxJobs = Math.max(1, Math.min(settings.maxJobs || 20, 50));
    const sign = (payload) => crypto.createHmac('sha256', tokenSecret).update(`spotlight-review-v1:${payload}`).digest('base64url');
    function tokenFor(record) {
        const payload = Buffer.from(JSON.stringify({ v: 1, sub: record.id, nonce: record.tokenNonce, exp: record.tokenExpiresAt })).toString('base64url');
        return `${payload}.${sign(payload)}`;
    }
    async function authenticate(token) {
        if (typeof token !== 'string' || token.length > 1500) fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN');
        const [payload, signature, extra] = token.split('.');
        if (!payload || !signature || extra) fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN');
        const expected = Buffer.from(sign(payload)); const actual = Buffer.from(signature);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN');
        let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN'); }
        if (data.v !== 1 || !idValid(data.sub) || !Number.isSafeInteger(data.exp) || data.exp <= now()) fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN');
        const record = await store.read(data.sub);
        if (!record || record.tokenNonce !== data.nonce || record.tokenExpiresAt !== data.exp) fail('This review link is invalid or expired.', 403, 'INVALID_TOKEN');
        return record;
    }
    function response(record) {
        return { applicationId: record.id, business: record.snapshot.profile, banner: record.banner || { status: 'none' }, bannerIncluded: Boolean(record.decision?.bannerUrl), customerEmail: record.snapshot.customerEmail, paidAmount: record.snapshot.paidAmount, currency: record.snapshot.currency, status: record.status, reviewDueAt: record.reviewDueAt, reason: record.reason || '', refundStatus: record.refund?.status || 'not_requested', refundNeedsAttention: Boolean(record.refund?.requiresAction || record.refund?.manualRequired), decisionAllowed: !record.decision && record.status !== 'needs_attention', decision: record.decision?.value || null };
    }
    async function change(applicationId, fn) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const current = await store.read(applicationId);
            if (!current) fail('Application not found.', 404, 'NOT_FOUND');
            const next = structuredClone(current);
            const result = fn(next, current);
            if (result === false) return { record: current, changed: false };
            next.revision = current.revision + 1;
            next.updatedAt = now();
            if (await store.compareAndSwap(applicationId, current.revision, next)) return { record: next, changed: true };
        }
        fail('Application changed. Please try again.', 503, 'RETRY_LATER');
    }
    async function claimedChange(applicationId, leaseOwner, fn) {
        return change(applicationId, (record) => {
            if (record.work.leaseOwner !== leaseOwner) return false;
            fn(record);
            return true;
        });
    }
    async function send(applicationId, owner, type) {
        let record = await store.read(applicationId);
        if (record.work.leaseOwner !== owner) return false;
        if (record.emails[type]?.state === 'sent') return true;
        if (!providers.emailReady()) throw Object.assign(new Error('Email is disabled; job retained.'), { status: 503, code: 'EMAIL_DISABLED' });
        const previous = record.emails[type];
        if (previous?.firstAttemptAt && now() - previous.firstAttemptAt >= (providers.emailIdempotencyWindowMs || 23 * 3600000)) throw attention('Email delivery needs review after its idempotency window.', 'EMAIL_IDEMPOTENCY_EXPIRED');
        if (['owner-review', 'owner-review-renewed', 'owner-overdue'].includes(type) && now() >= record.tokenExpiresAt) throw attention('Review link expired before email could be delivered.');
        // Persist exact payload before sending. Provider idempotency must always see
        // the same message, including token and decline reason, across retries.
        const prepared = await claimedChange(applicationId, owner, (current) => {
            const job = current.emails[type] || { state: 'queued', firstAttemptAt: now(), attempts: 0, payload: buildEmail(current, type, settings, tokenFor(current)) };
            job.firstAttemptAt = job.firstAttemptAt || now(); job.attempts += 1;
            current.emails[type] = job;
            current.work.leaseUntil = now() + leaseMs;
        });
        if (!prepared.changed) return false;
        record = prepared.record;
        const receipt = await providers.sendEmail(record.emails[type].payload, `spotlight:${applicationId}:${type}`);
        const saved = await claimedChange(applicationId, owner, (current) => { current.emails[type].state = 'sent'; current.emails[type].sentAt = now(); current.emails[type].receipt = receipt.id; });
        return saved.changed;
    }
    async function run(applicationId) {
        const owner = crypto.randomUUID();
        const claimed = await change(applicationId, (record) => {
            if (!['queued', 'leased'].includes(record.work.state) || record.work.nextAttemptAt > now() || record.work.leaseUntil > now()) return false;
            Object.assign(record.work, { state: 'leased', leaseOwner: owner, leaseUntil: now() + leaseMs, attempts: record.work.attempts + 1 });
        });
        if (!claimed.changed) return claimed.record;
        async function owned() {
            const result = await claimedChange(applicationId, owner, (record) => { record.work.leaseUntil = now() + leaseMs; });
            return result.changed ? result.record : null;
        }
        async function checkpoint(fn) { return (await claimedChange(applicationId, owner, fn)).changed; }
        let processingAttention = false;
        try {
            let record = await owned(); if (!record) return store.read(applicationId);
            if (record.status === 'needs_attention') {
                // An operator alert is its own durable job. Retrying the alert
                // must never repeat or resume a financial decision that failed
                // a safety check.
                processingAttention = true;
                if (!await send(applicationId, owner, 'owner-attention')) return store.read(applicationId);
                await checkpoint((current) => { Object.assign(current.work, { state: 'attention', nextAttemptAt: 0, leaseUntil: 0, leaseOwner: '' }); });
                return store.read(applicationId);
            }
            if (!record.effects.held && !record.decision) {
                await providers.hold(record.snapshot);
                if (!await checkpoint((current) => { current.effects.held = true; })) return store.read(applicationId);
            }
            record = await owned(); if (!record) return store.read(applicationId);
            if (!record.decision && !record.banner && banners) {
                let banner;
                try { banner = await banners.discover(record.snapshot); }
                catch { banner = { status: 'unavailable', discoveredAt: now() }; }
                // Banner discovery is optional: failures never stop approval,
                // payment handling or review emails. A decision freezes its image.
                if (!await checkpoint(current => { if (!current.decision) current.banner = banner; })) return store.read(applicationId);
                record = await owned(); if (!record) return store.read(applicationId);
            }
            if (!record.decision) {
                if (now() >= record.tokenExpiresAt) {
                    if (record.tokenRenewals >= 1) throw attention('The renewed review link expired without a decision.', 'REVIEW_EXPIRED');
                    if (!await checkpoint((current) => { current.tokenNonce = crypto.randomBytes(24).toString('base64url'); current.tokenExpiresAt = now() + tokenTtl; current.tokenRenewals = 1; })) return store.read(applicationId);
                    record = await owned(); if (!record) return store.read(applicationId);
                }
                if (!await send(applicationId, owner, record.tokenRenewals ? 'owner-review-renewed' : 'owner-review')) return store.read(applicationId);
                if (!await send(applicationId, owner, 'applicant-received')) return store.read(applicationId);
                record = await owned(); if (!record) return store.read(applicationId);
                if (!record.decision && now() >= record.reviewDueAt && !await send(applicationId, owner, 'owner-overdue')) return store.read(applicationId);
            }
            record = await owned(); if (!record) return store.read(applicationId);
            if (record.decision?.value === 'approve') {
                if (!record.effects.held && !record.effects.approved) { await providers.hold(record.snapshot); if (!await checkpoint((current) => { current.effects.held = true; })) return store.read(applicationId); }
                record = await owned(); if (!record) return store.read(applicationId);
                if (!record.effects.approved) {
                    await providers.approve(record.snapshot, record.decision.bannerUrl || '');
                    if (!await checkpoint((current) => { current.effects.approved = true; current.status = 'approved'; })) return store.read(applicationId);
                }
                if (!await send(applicationId, owner, 'applicant-approved')) return store.read(applicationId);
            } else if (record.decision?.value === 'decline') {
                if (!record.effects.canceled) {
                    await providers.cancel(record.snapshot, record.reason);
                    if (!await checkpoint((current) => { current.effects.canceled = true; })) return store.read(applicationId);
                }
                record = await owned(); if (!record) return store.read(applicationId);
                if (record.refund?.status !== 'succeeded') {
                    const refund = await providers.refund(record.snapshot);
                    if (!['pending', 'failed', 'succeeded'].includes(refund?.status) || (refund.status === 'succeeded' && refund.refundedAmount !== 10000)) throw attention('A full refund has not been confirmed.');
                    if (!await checkpoint((current) => { current.refund = refund; if (refund.status === 'succeeded') current.status = 'declined'; })) return store.read(applicationId);
                }
                record = await owned(); if (!record) return store.read(applicationId);
                if (record.refund?.requiresAction || record.refund?.manualRequired) {
                    if (!await send(applicationId, owner, 'owner-refund-attention')) return store.read(applicationId);
                }
                if (record.refund.status === 'succeeded') {
                    if (!await send(applicationId, owner, 'applicant-declined')) return store.read(applicationId);
                } else {
                    if (!await send(applicationId, owner, 'applicant-declining')) return store.read(applicationId);
                }
            }
            await checkpoint((current) => {
                const refundPending = current.decision?.value === 'decline' && current.refund?.status !== 'succeeded';
                const awaitingReview = !current.decision;
                const reviewWakeAt = current.emails['owner-overdue']?.state === 'sent' ? current.tokenExpiresAt : current.reviewDueAt;
                const decisionUnfinished = current.decision?.value === 'approve' ? !current.effects.approved || current.emails['applicant-approved']?.state !== 'sent' : current.decision?.value === 'decline' ? !current.effects.canceled : false;
                Object.assign(current.work, { state: refundPending || awaitingReview || decisionUnfinished ? 'queued' : 'idle', nextAttemptAt: decisionUnfinished ? now() : refundPending ? now() + retryMs : awaitingReview ? reviewWakeAt : 0, leaseUntil: 0, leaseOwner: '', lastError: null });
            });
        } catch (error) {
            await checkpoint((record) => {
                const needsAttention = error.code === 'NEEDS_ATTENTION' || error.status === 409 || [401, 403, 404].includes(error.statusCode);
                if (needsAttention) { record.attention = record.attention || { code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'RETRY_LATER', at: now() }; record.status = 'needs_attention'; }
                const alertUncertainBeyondWindow = processingAttention && error.code === 'EMAIL_IDEMPOTENCY_EXPIRED';
                Object.assign(record.work, { state: alertUncertainBeyondWindow ? 'attention' : 'queued', nextAttemptAt: now() + retryMs, leaseUntil: 0, leaseOwner: '', lastError: { code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'RETRY_LATER', at: now() } });
            });
        }
        return store.read(applicationId);
    }
    async function ingest({ subscriptionId } = {}) {
        if (!idValid(subscriptionId)) fail('Invalid subscription.');
        let record = await store.read(subscriptionId);
        if (!record) {
            const snapshot = await providers.inspectInitial(subscriptionId);
            // Unpaid/canceled/foreign events without an existing application are
            // acknowledged, never converted into new paid applications.
            if (!snapshot) return { ignored: true, reviewStatus: 'not_applicable' };
            if (snapshot.subscriptionId !== subscriptionId || snapshot.paidAmount !== 10000 || snapshot.currency !== 'usd' || snapshot.profileHash !== profileHash(snapshot.profile)) fail('Payment does not match the application.', 409, 'PAYMENT_MISMATCH');
            const timestamp = now();
            const paidAt = Number.isSafeInteger(snapshot.paidAt) && snapshot.paidAt > 0 && snapshot.paidAt <= timestamp ? snapshot.paidAt : timestamp;
            const fresh = { id: subscriptionId, revision: 1, snapshot, createdAt: timestamp, updatedAt: timestamp, status: 'pending', decision: null, reason: '', reviewDueAt: paidAt + (settings.reviewWithinMs || 2 * 86400000), tokenNonce: crypto.randomBytes(24).toString('base64url'), tokenExpiresAt: timestamp + tokenTtl, effects: { held: false, approved: false, canceled: false }, refund: { status: 'not_requested', refundedAmount: 0 }, emails: {}, work: { state: 'queued', nextAttemptAt: timestamp, leaseUntil: 0, leaseOwner: '', attempts: 0 } };
            await store.create(subscriptionId, fresh);
            record = await store.read(subscriptionId);
        } else if (record.decision?.value === 'decline' && record.refund?.status !== 'succeeded' && record.work.state !== 'attention') {
            // A refund status webhook wakes a durable refund check promptly.
            record = (await change(subscriptionId, (current) => { current.work.nextAttemptAt = now(); if (current.work.state !== 'leased') current.work.state = 'queued'; })).record;
        }
        return response(await run(subscriptionId));
    }
    async function review({ token } = {}) { return response(await authenticate(token)); }
    async function decide({ token, decision, reason, confirmed, useBanner, bannerVersion } = {}) {
        if (confirmed !== true || !['approve', 'decline'].includes(decision)) fail('Confirm an approve or decline decision.');
        const cleanReason = decision === 'decline' && typeof reason === 'string' ? reason.replace(/\r\n|\r|\n/g, ' ').trim() : '';
        if (decision === 'decline' && (!cleanReason || cleanReason.length > 500 || /[\u0000-\u001f\u007f]/.test(cleanReason))) fail('Provide a decline reason of up to 500 characters.');
        const authenticated = await authenticate(token);
        const selected = await change(authenticated.id, (record) => {
            if (record.decision) {
                if (record.decision.value !== decision || record.reason !== cleanReason || (decision === 'approve' && typeof useBanner === 'boolean' && Boolean(record.decision.bannerUrl) !== useBanner)) fail('This application already has a different decision.', 409, 'DECISION_CONFLICT');
                return false;
            }
            if (record.status === 'needs_attention') fail('This application requires manual attention before a decision.', 409, 'NEEDS_ATTENTION');
            if (decision === 'approve' && record.banner?.status === 'ready' && (typeof useBanner !== 'boolean' || bannerVersion !== record.banner.version)) fail('The banner changed. Refresh and review the image before approving.', 409, 'BANNER_CHANGED');
            record.decision = { value: decision, at: now(), bannerUrl: decision === 'approve' && useBanner === true && record.banner?.status === 'ready' ? record.banner.url : '' }; record.reason = cleanReason;
            record.status = decision === 'approve' ? 'approving' : 'declining';
            record.work.nextAttemptAt = now();
            if (record.work.state !== 'leased') record.work.state = 'queued';
        });
        return response(await run(selected.record.id));
    }
    async function retry() {
        const due = await store.listDue({ now: now(), limit: maxJobs });
        const result = { considered: due.length, processed: 0, attention: 0 };
        const deadline = now() + 75000;
        for (const candidate of due) {
            if (now() > deadline) break;
            const record = await run(candidate.id);
            result.processed += 1;
            if (record.work.state === 'attention') result.attention += 1;
        }
        return result;
    }
    return { ingest, review, decide, retry };
}
module.exports = { createModeration };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewDeadline, upgradePendingReview, REVIEW_POLICY } = require('./review-window');
const { buildEmail } = require('./emails');
test('five Pacific weekdays skip weekends and preserve local time across DST and year boundaries', () => {
    for (const [paid, due] of [
        ['2026-11-05T09:05:57-08:00', '2026-11-12T09:05:57-08:00'],
        ['2026-11-06T16:30:00-08:00', '2026-11-13T16:30:00-08:00'],
        ['2026-11-07T11:00:00-08:00', '2026-11-13T11:00:00-08:00'],
        ['2026-11-08T11:00:00-08:00', '2026-11-13T11:00:00-08:00'],
        ['2026-10-30T09:00:00-07:00', '2026-11-06T09:00:00-08:00'],
        ['2026-03-06T09:00:00-08:00', '2026-03-13T09:00:00-07:00'],
        ['2026-12-31T23:30:00-08:00', '2027-01-07T23:30:00-08:00'],
    ]) assert.equal(new Date(reviewDeadline(Date.parse(paid))).toISOString(), new Date(due).toISOString(), paid);
    assert.throws(() => reviewDeadline(NaN));
});
test('migration changes only pending review scheduling and preserves financial, email and token history', () => {
    const paidAt = Date.parse('2026-11-05T17:05:57Z'), now = Date.parse('2026-11-07T20:00:00Z');
    const record = { id: 'sub_test', revision: 4, status: 'pending', decision: null, snapshot: { paidAt }, reviewDueAt: paidAt + 172800000, tokenExpiresAt: paidAt + 604800000, tokenNonce: 'original', effects: { held: true }, refund: { status: 'not_requested' }, emails: { 'owner-overdue': { state: 'sent', receipt: 'old-receipt' } }, work: { state: 'queued', nextAttemptAt: paidAt + 604800000, leaseUntil: 0 } };
    const before = structuredClone(record), next = upgradePendingReview(record, now);
    assert.deepEqual(record, before);
    assert.equal(next.reviewDueAt, Date.parse('2026-11-12T17:05:57Z'));
    assert.equal(next.reviewPolicy, REVIEW_POLICY);
    assert.equal(next.work.nextAttemptAt, next.reviewDueAt);
    for (const key of ['id', 'snapshot', 'status', 'decision', 'effects', 'refund', 'emails', 'tokenNonce', 'tokenExpiresAt']) assert.deepEqual(next[key], record[key], key);
    assert.equal(upgradePendingReview(next, now), null);
    assert.equal(upgradePendingReview({ ...record, status: 'approved' }, now), null);
    assert.equal(upgradePendingReview({ ...record, decision: { value: 'decline' } }, now), null);
    assert.equal(upgradePendingReview({ ...record, work: { ...record.work, leaseUntil: now + 1000 } }, now), null);
});
test('all review notifications use the new window and renewed links do not imply a premature overdue status', () => {
    const record = { id: 'sub_test', snapshot: { profile: { businessName: 'Example' }, customerEmail: 'test@example.com' }, work: {}, effects: {} };
    for (const type of ['owner-review', 'applicant-received', 'owner-overdue-business-week', 'owner-review-renewed']) {
        const mail = buildEmail(record, type, { siteUrl: 'https://example.com', live: true }, 'test.token');
        assert.doesNotMatch(mail.text, /two.day|2 days|48 hours/i);
        assert.match(mail.text, /one.business.week/);
        if (type === 'owner-review-renewed') assert.doesNotMatch(mail.text, /already passed/);
    }
});

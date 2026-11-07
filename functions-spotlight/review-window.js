'use strict';

const REVIEW_POLICY = 'five-business-days-v1';
const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function localParts(timestamp) {
    return Object.fromEntries(zone.formatToParts(timestamp).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function wallTime(parts) { return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); }

// Count the five weekdays after payment, retaining the Pacific wall-clock time.
// Weekends are excluded; holidays are not a separate configured calendar.
function reviewDeadline(paidAt) {
    if (!Number.isSafeInteger(paidAt) || paidAt <= 0) throw new Error('Invalid payment timestamp');
    const parts = localParts(paidAt);
    const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    for (let remaining = 5; remaining > 0;) {
        calendar.setUTCDate(calendar.getUTCDate() + 1);
        if (![0, 6].includes(calendar.getUTCDay())) remaining -= 1;
    }
    const target = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), parts.hour, parts.minute, parts.second);
    let result = target;
    for (let pass = 0; pass < 3; pass += 1) result += target - wallTime(localParts(result));
    return result + paidAt % 1000;
}

// Reusable, side-effect-free migration. Financial and decision records stay intact.
function upgradePendingReview(record, now = Date.now()) {
    if (record.status !== 'pending' || record.decision || record.reviewPolicy === REVIEW_POLICY) return null;
    if (record.work?.leaseUntil > now || !['queued', 'idle'].includes(record.work?.state)) return null;
    const next = structuredClone(record);
    next.reviewDueAt = reviewDeadline(record.snapshot.paidAt);
    next.reviewPolicy = REVIEW_POLICY;
    next.reviewWindowMigration = { at: now, previousDueAt: record.reviewDueAt, previousPolicy: record.reviewPolicy || 'two-calendar-days' };
    next.revision += 1; next.updatedAt = now;
    next.work.nextAttemptAt = Math.min(next.reviewDueAt, next.tokenExpiresAt);
    next.work.state = 'queued';
    return next;
}
module.exports = { REVIEW_POLICY, reviewDeadline, upgradePendingReview };

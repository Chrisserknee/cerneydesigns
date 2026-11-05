'use strict';

((root, factory) => {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CerneySelectsDailyOrder = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
    const calendar = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    function dayNumber(date = new Date()) {
        const parts = Object.fromEntries(calendar.formatToParts(date).map(({ type, value }) => [type, value]));
        // Use the local calendar date, so daylight-saving changes still count as one day.
        return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000);
    }
    function order(businesses, date = new Date()) {
        const sorted = [...businesses].sort((a, b) =>
            a.businessName.localeCompare(b.businessName, 'en', { sensitivity: 'base' })
            || String(a.id || a.website || '').localeCompare(String(b.id || b.website || ''), 'en'));
        if (sorted.length < 2) return sorted;
        // A rotating queue gives every business a first position once per full cycle.
        const offset = ((dayNumber(date) % sorted.length) + sorted.length) % sorted.length;
        return [...sorted.slice(offset), ...sorted.slice(0, offset)];
    }
    return Object.freeze({ dayNumber, order });
});

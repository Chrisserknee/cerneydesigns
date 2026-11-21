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
    const partnerIds = new Set([
        '44400b425cc8748c860f', // Dunnion Law
        'b9be0d16321a03694019', // Hare Construction
    ]);
    function rotate(rows, day) {
        if (rows.length < 2) return rows;
        const offset = ((day % rows.length) + rows.length) % rows.length;
        return [...rows.slice(offset), ...rows.slice(0, offset)];
    }
    function order(businesses, date = new Date()) {
        const sorted = [...businesses].sort((a, b) =>
            a.businessName.localeCompare(b.businessName, 'en', { sensitivity: 'base' })
            || String(a.id || a.website || '').localeCompare(String(b.id || b.website || ''), 'en'));
        const day = dayNumber(date);
        const partners = sorted.filter(row => partnerIds.has(row.id) && row.membershipBadge);
        if (!partners.length || partners.length === sorted.length) return rotate(sorted, day);

        const cycleDay = ((day % 3) + 3) % 3;
        // Advance the unrestricted rotation once per cycle so everyone can lead.
        if (cycleDay === 2) return rotate(sorted, Math.floor(day / 3));

        const others = rotate(sorted.filter(row => !partners.includes(row)), day);
        const [lead, ...remainingPartners] = rotate(partners, cycleDay);
        return [lead, others[0], ...remainingPartners, ...others.slice(1)];
    }
    return Object.freeze({ dayNumber, order });
});

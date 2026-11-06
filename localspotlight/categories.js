'use strict';

// Display groups are independent of stored category values. Preserve existing
// profile hashes, pending reviews and the backend's accepted signup values.
(function (root) {
    const groups = [
        { label: 'Food & Drink', icon: '♨', values: ['Food & Restaurants', 'Drinks & Nightlife'] },
        { label: 'Shopping & Local Goods', icon: '◈', values: ['Shopping & Local Makers', 'Farms, Outdoors & Local Living'] },
        { label: 'Things to Do & Community', icon: '☀', values: ['Family & Community', 'Experiences & Entertainment'] },
        { label: 'Home & Auto Services', icon: '⌂', values: ['Home & Property', 'Auto & Transportation'] },
        { label: 'Health & Wellness', icon: '♡', values: ['Health & Wellness'] },
        { label: 'Professional Services', icon: '✧', values: ['Professional Services'] },
    ];
    const display = value => groups.find(group => group.label === value || group.values.includes(value))?.label || value;
    const api = { groups, display };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CerneySelectsCategories = api;
})(typeof window === 'object' ? window : globalThis);

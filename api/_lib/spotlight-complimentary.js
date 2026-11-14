'use strict';

const approvedListings = require('./spotlight-complimentary.json');

// Owner-approved complimentary spots are maintained on the server, separately
// from Stripe memberships. Public signup metadata can never opt into this path.
// Hide a spot by setting hidden:true (or status:"inactive") and redeploying.
function complimentaryListings(settings, validateProfile, paidListings = [], records = approvedListings) {
    if (!settings.live || !settings.publicDirectory) return [];
    const identity = value => String(value || '').toLowerCase().replace(/\/+$/, '');
    return records.filter(record => record.status === 'approved' && record.hidden === false && record.billing === 'complimentary')
        .map(record => {
            if (!/^complimentary-[a-z0-9-]+$/.test(record.id)) throw new Error('Invalid complimentary listing ID');
            const profile = validateProfile(record.profile);
            if (!/^\/localspotlight\/banners\/[a-z0-9-]+\.webp$/.test(record.bannerUrl || '')) throw new Error('Invalid complimentary banner');
            // Explicit projection keeps approval notes and billing metadata private.
            return { id: record.id, ...profile, bannerUrl: record.bannerUrl, listingType: 'complimentary' };
        }).filter(profile => !paidListings.some(paid => paid.id === profile.id
            || identity(paid.website) === identity(profile.website)
            || (profile.instagramUrl && identity(paid.instagramUrl) === identity(profile.instagramUrl))));
}

module.exports = { complimentaryListings };

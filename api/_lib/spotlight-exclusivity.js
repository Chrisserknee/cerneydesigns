'use strict';

const { createHash } = require('node:crypto');

// Manually negotiated agreements. Add or retire entries when the agreement changes.
// Separately, paid member specialty entitlements are read from the live directory.
const agreements = [
    {
        id: '44400b425cc8748c860f', holder: 'Dunnion Law', specialty: 'Personal injury law',
        terms: /\b(personal injur\w*|injury (law\w*|attorney\w*|claim\w*)|accident (law\w*|attorney\w*)|wrongful death|law firm|law offices?|attorneys?|lawyers?)\b/,
    },
    {
        id: 'b9be0d16321a03694019', holder: 'Hare Construction Inc.', specialty: 'Construction',
        terms: /\b(construction|contractors?|contracting|homebuilders?|builders?|custom homes?|design build|remodel\w*|renovat\w*|general building)\b/,
    },
];
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function reviewPartnerships(application, listings) {
    const profile = application.business;
    const candidate = ' ' + [profile.businessName, profile.description, profile.website, profile.category].map(normalize).join(' ') + ' ';
    const self = createHash('sha256').update('spotlight:' + application.applicationId).digest('hex').slice(0, 20);
    const partners = agreements.filter(p => p.id !== self).map(p => ({
        holder: p.holder, specialty: p.specialty, possibleMatch: p.terms.test(candidate),
    }));
    for (const listing of listings || []) {
        const specialty = listing.featured?.specialty;
        if (!specialty || listing.id === self) continue;
        if (partners.some(p => p.holder === listing.businessName && normalize(p.specialty) === normalize(specialty))) continue;
        partners.push({ holder: listing.businessName, specialty: specialty + ' (featured specialty)',
            possibleMatch: candidate.includes(' ' + normalize(specialty) + ' ') });
    }
    return { partners, incomplete: !Array.isArray(listings) };
}

async function loadReviewPartnerships(application) {
    let listings;
    try {
        const response = await fetch('https://cerneyselects.com/api/spotlight', { signal: AbortSignal.timeout(5500), redirect: 'error' });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.listings)) listings = data.listings;
        }
    } catch { /* Keep the manual agreements visible when the public directory is unavailable. */ }
    return reviewPartnerships(application, listings);
}
module.exports = { reviewPartnerships, loadReviewPartnerships };

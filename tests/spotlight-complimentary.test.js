'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { complimentaryListings } = require('../api/_lib/spotlight-complimentary');
const { createService, validateProfile } = require('../api/_lib/spotlight');
const approved = require('../api/_lib/spotlight-complimentary.json');
const live = { live: true, publicDirectory: true };

test('explicitly approved complimentary listing publishes without billing calls or private metadata', async () => {
    const forbiddenBilling = new Proxy({}, { get() { throw new Error('Complimentary spot must not call Stripe'); } });
    const directory = await createService(forbiddenBilling, live).directory();
    assert.equal(directory.listings.length, 1);
    const listing = directory.listings[0];
    assert.equal(listing.businessName, 'The Underground Forrest');
    assert.equal(listing.website, 'https://theundergroundforrest.square.site/');
    assert.equal(listing.instagramUrl, 'https://www.instagram.com/theundergroundforrest_/');
    assert.equal(listing.phone, '');
    for (const field of ['approvalNote', 'billing', 'approvedAt', 'status', 'email', 'membershipBadge']) assert.equal(listing[field], undefined);
});

test('complimentary records require explicit approval, active visibility and production launch', () => {
    for (const settings of [{ live: false, publicDirectory: true }, { live: true, publicDirectory: false }]) {
        assert.deepEqual(complimentaryListings(settings, validateProfile), []);
    }
    for (const changes of [{ status: 'pending' }, { status: 'inactive' }, { hidden: true }, { billing: 'paid' }]) {
        assert.deepEqual(complimentaryListings(live, validateProfile, [], [{ ...approved[0], ...changes }]), []);
    }
    assert.throws(() => complimentaryListings(live, validateProfile, [], [{ ...approved[0], profile: { ...approved[0].profile, website: 'javascript:alert(1)' } }]));
});

test('a later paid listing for the same business replaces the complimentary entry without duplication', () => {
    for (const paid of [{ website: approved[0].profile.website }, { instagramUrl: approved[0].profile.instagramUrl }]) {
        assert.deepEqual(complimentaryListings(live, validateProfile, [paid]), []);
    }
    assert.equal(complimentaryListings(live, validateProfile, [{ website: 'https://other.example/' }]).length, 1);
});

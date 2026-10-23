'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile, profileMetadata, readProfile, publicProfileHash } = require('../api/_lib/spotlight');
const { profileFrom, profileHash } = require('../functions-spotlight/providers');
const base = { businessName: 'Example', category: 'Food & Restaurants', city: 'Carmel', description: 'A local business.', website: 'https://example.com/', phone: '', logoUrl: '' };
test('chosen banner survives metadata and both approval hashes bind the selection', () => {
 const oldHash = publicProfileHash(base);
 assert.equal(publicProfileHash(validateProfile({...base, bannerSourceUrl: ''})), oldHash);
 const profile = validateProfile({...base, bannerSourceUrl: 'https://example.com/wide.jpg'});
 const metadata = profileMetadata(profile);
 assert.deepEqual(readProfile(metadata), profile);
 assert.deepEqual(profileFrom(metadata), profile);
 assert.equal(profileHash(profileFrom(metadata)), publicProfileHash(profile));
 assert.notEqual(publicProfileHash(profile), oldHash);
 assert.notEqual(publicProfileHash({...profile,bannerSourceUrl:'https://example.com/other.jpg'}),publicProfileHash(profile));
});
test('invalid banner links fail before checkout', () => {
 for(const url of ['http://example.com/a.jpg','https://127.0.0.1/a.jpg','https://user:pass@example.com/a.jpg','https://host.local/a.jpg','x'.repeat(501)]) assert.throws(()=>validateProfile({...base,bannerSourceUrl:url}));
});

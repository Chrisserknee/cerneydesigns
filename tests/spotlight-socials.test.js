'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const socials = require('../localspotlight/social-links');
const { validateProfile, publicProfileHash, profileMetadata, readProfile } = require('../api/_lib/spotlight');
const { profileHash, profileFrom } = require('../functions-spotlight/providers');
const base = { businessName: 'Example Coffee', category: 'Food & Restaurants', city: 'Monterey', description: 'A synthetic business.', website: 'https://example.com/', phone: '', logoUrl: '' };

test('accepts optional social handles and canonical profile links, discarding tracking', () => {
    const samples = [
        ['instagramUrl', '@Example.Coffee', 'https://www.instagram.com/example.coffee/'],
        ['instagramUrl', 'instagram.com/example.coffee/?igsh=abc#track', 'https://www.instagram.com/example.coffee/'],
        ['facebookUrl', 'https://m.facebook.com/ExampleCoffee?mibextid=123', 'https://www.facebook.com/ExampleCoffee/'],
        ['facebookUrl', 'https://facebook.com/profile.php?id=123456&ref=share', 'https://www.facebook.com/profile.php?id=123456'],
        ['facebookUrl', 'https://www.facebook.com/people/Example-Coffee/123456/', 'https://www.facebook.com/people/Example-Coffee/123456/'],
        ['tiktokUrl', 'Example.Coffee', 'https://www.tiktok.com/@example.coffee'],
        ['tiktokUrl', 'https://www.tiktok.com/@example.coffee?lang=en', 'https://www.tiktok.com/@example.coffee'],
    ];
    for (const [field, input, expected] of samples) assert.equal(socials.normalize(field, input), expected);
    assert.deepEqual(socials.read({ instagramUrl: '', facebookUrl: ' ', tiktokUrl: undefined }), {});
});

test('rejects non-profile links, impersonating hosts, executable schemes, credentials and malformed values', () => {
    const invalid = [
        ['instagramUrl', 'https://instagram.com.evil.example/business'],
        ['instagramUrl', 'https://instagram.com@evil.example/business'],
        ['instagramUrl', 'https://user:pass@instagram.com/business'],
        ['instagramUrl', 'javascript:alert(1)'], ['instagramUrl', 'data:text/html,hi'],
        ['instagramUrl', 'https://instagram.com:8080/business'],
        ['instagramUrl', 'https://instagram.com/p/post'], ['instagramUrl', 'https://instagram.com/accounts'],
        ['instagramUrl', 'https://instagram.com/%61ccounts'], ['instagramUrl', 'https://instagram.com/abc%2fdef'],
        ['instagramUrl', 'https://instagram.com\\@evil.example/business'],
        ['instagramUrl', 'https://instagram.com/abc\n'], ['instagramUrl', 'http://instagram.com/business'],
        ['facebookUrl', 'https://l.facebook.com/l.php?u=https://evil.example'],
        ['facebookUrl', 'https://facebook.com/l.php?u=https://evil.example'],
        ['facebookUrl', 'https://facebook.com/sharer.php?u=https://evil.example'],
        ['facebookUrl', 'https://facebook.com/profile.php?id=abc'],
        ['facebookUrl', 'https://facebook.com/share/abc'],
        ['tiktokUrl', 'https://vm.tiktok.com/abc'], ['tiktokUrl', 'https://tiktok.com/@person/video/123'],
        ['tiktokUrl', 'https://facebook.com/business'], ['tiktokUrl', { url: 'https://tiktok.com/@abc' }],
    ];
    for (const [field, input] of invalid) assert.throws(() => socials.normalize(field, input), undefined, `${field}: ${JSON.stringify(input)}`);
});

test('API and moderation agree on normalized socials and keep old approval hashes unchanged', () => {
    const fields = ['businessName', 'category', 'city', 'description', 'website', 'phone', 'logoUrl'];
    const oldHash = crypto.createHash('sha256').update(JSON.stringify(fields.map(key => [key, base[key] || '']))).digest('hex');
    for (const profile of [base, { ...base, instagramUrl: '', facebookUrl: '', tiktokUrl: '' }]) {
        assert.equal(publicProfileHash(profile), oldHash); assert.equal(profileHash(profile), oldHash);
        assert.deepEqual(validateProfile(profile), base);
        assert.deepEqual(profileFrom(profileMetadata(profile)), base);
    }
    const profile = validateProfile({ ...base, instagramUrl: '@examplecoffee', facebookUrl: '@ExampleCoffee', tiktokUrl: '@examplecoffee' });
    const metadata = profileMetadata(profile);
    assert.deepEqual(readProfile(metadata), profile); assert.deepEqual(profileFrom(metadata), profile);
    assert.equal(profileHash(profile), publicProfileHash(profile)); assert.notEqual(profileHash(profile), oldHash);
    for (const { field, metadata: key } of socials.platforms) {
        const changed = { ...profile, [field]: socials.normalize(field, '@differentbusiness') };
        assert.notEqual(publicProfileHash(changed), publicProfileHash(profile));
        assert.equal(profileHash(changed), publicProfileHash(changed));
        assert.throws(() => profileFrom({ ...metadata, [key]: 'https://evil.example/' }), { code: 'PROFILE_CHANGED' });
        assert.equal(readProfile({ ...metadata, [key]: 'https://evil.example/' }), null);
    }
});

test('browser and separately deployed Firebase use exactly the same social validation rules', () => {
    assert.equal(fs.readFileSync(require.resolve('../localspotlight/social-links'), 'utf8'), fs.readFileSync(require.resolve('../functions-spotlight/social-links'), 'utf8'));
});

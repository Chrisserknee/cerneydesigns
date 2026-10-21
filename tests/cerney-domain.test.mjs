import test from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.ts';
import { issueCookie } from '../spotlight-gate.cjs';

process.env.SPOTLIGHT_PREVIEW_PASSWORD = 'test-only-password';
process.env.SPOTLIGHT_PREVIEW_SESSION_SECRET = 'test-only-secret-'.repeat(4);
const cookie = issueCookie(process.env.SPOTLIGHT_PREVIEW_SESSION_SECRET);

test('new domain requires the preview password at its root and on assets', async () => {
    for (const path of ['/', '/localspotlight/preview/businesses.json', '/spotlightsignup/']) {
        const response = await middleware(new Request('https://cerneyselects.com' + path));
        assert.equal(response.status, 401);
        assert.match(await response.text(), /CerneySelects/);
    }
});

test('authenticated root serves the directory, preserves search and blocks caching', async () => {
    const response = await middleware(new Request('https://cerneyselects.com/?count=100', { headers: { cookie } }));
    assert.equal(response.headers.get('x-middleware-rewrite'), 'https://cerneyselects.com/localspotlight/index.html?count=100');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-security-policy'), /fonts.googleapis.com/);
});

test('reporting homepage and crawler files are unchanged and ignore a forged forwarded host', async () => {
    for (const path of ['/', '/index.html', '/robots.txt', '/sitemap.xml']) {
        const response = await middleware(new Request('https://www.chriscerney.org' + path, { headers: { 'x-forwarded-host': 'cerneyselects.com' } }));
        assert.equal(response.headers.get('x-middleware-next'), '1');
        assert.equal(response.headers.get('x-middleware-rewrite'), null);
    }
});

test('legacy directory links and www resolve to the canonical new homepage', async () => {
    for (const url of ['https://www.chriscerney.org/localspotlight/?count=20', 'https://cerneyselects.com/localspotlight/?count=20', 'https://www.cerneyselects.com/?count=20']) {
        const response = await middleware(new Request(url));
        assert.equal(response.status, 308);
        assert.equal(response.headers.get('location'), 'https://cerneyselects.com/?count=20');
    }
});

test('preview login works on the new domain with a secure domain-local cookie', async () => {
    const response = await middleware(new Request('https://cerneyselects.com/', {
        method: 'POST', headers: { origin: 'https://cerneyselects.com' }, body: 'password=test-only-password',
    }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.match(response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(response.headers.get('set-cookie'), /Domain=/i);
});

test('new domain crawler files retain the private preview policy', async () => {
    const robots = await middleware(new Request('https://cerneyselects.com/robots.txt'));
    assert.match(await robots.text(), /Disallow: \//);
    const sitemap = await middleware(new Request('https://cerneyselects.com/sitemap.xml'));
    assert.doesNotMatch(await sitemap.text(), /chriscerney.org/);
});

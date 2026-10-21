import test from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.ts';
import { issueCookie } from '../spotlight-gate.cjs';

process.env.SPOTLIGHT_PREVIEW_PASSWORD = 'test-only-password';
process.env.SPOTLIGHT_PREVIEW_SESSION_SECRET = 'test-only-secret-'.repeat(4);
delete process.env.CERNEYSELECTS_PUBLIC;
const cookie = issueCookie(process.env.SPOTLIGHT_PREVIEW_SESSION_SECRET);

test('new domain requires the preview password at its root and on assets', async () => {
    for (const path of ['/', '/localspotlight/preview/businesses.json', '/apply/']) {
        const response = await middleware(new Request('https://cerneyselects.com' + path));
        assert.equal(response.status, 401);
        assert.match(await response.text(), /CerneySelects/);
    }
});

test('authenticated root serves the directory, preserves search and blocks caching', async () => {
    const response = await middleware(new Request('https://cerneyselects.com/?count=100', { headers: { cookie } }));
    assert.equal(response.headers.get('x-middleware-rewrite'), 'https://cerneyselects.com/localspotlight/preview/index.html?count=100');
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

test('public launch serves real listings while example pages and data remain password protected', async () => {
    process.env.CERNEYSELECTS_PUBLIC = 'true';
    try {
        const home = await middleware(new Request('https://cerneyselects.com/'));
        assert.equal(home.headers.get('x-middleware-rewrite'), 'https://cerneyselects.com/localspotlight/index.html');
        assert.equal(home.headers.get('x-robots-tag'), 'index, follow');
        for (const path of ['/localspotlight/preview/', '/localspotlight/preview/businesses.json', '/localspotlight/preview/assets/brand-000.png']) {
            const response = await middleware(new Request('https://cerneyselects.com' + path));
            assert.equal(response.status, 401);
            assert.match(response.headers.get('cache-control'), /no-store/);
        }
        const api = await middleware(new Request('https://cerneyselects.com/api/spotlight'));
        assert.equal(api.headers.get('x-middleware-next'), '1');
        const apply = await middleware(new Request('https://cerneyselects.com/apply/'));
        assert.equal(apply.headers.get('x-middleware-rewrite'), 'https://cerneyselects.com/spotlightsignup/index.html');
    } finally { delete process.env.CERNEYSELECTS_PUBLIC; }
});

test('public sitemap contains only CerneySelects public pages and protects private discovery paths', async () => {
    process.env.CERNEYSELECTS_PUBLIC = 'true';
    try {
        const robots = await middleware(new Request('https://cerneyselects.com/robots.txt'));
        const rules = await robots.text();
        assert.match(rules, /Allow: \/\n/);
        assert.match(rules, /Disallow: \/localspotlight\/preview\//);
        const sitemap = await middleware(new Request('https://cerneyselects.com/sitemap.xml'));
        const xml = await sitemap.text();
        assert.match(xml, /<loc>https:\/\/cerneyselects.com\/<\/loc>/);
        assert.match(xml, /<loc>https:\/\/cerneyselects.com\/apply\/<\/loc>/);
        assert.doesNotMatch(xml, /preview|chriscerney.org|api\//);
    } finally { delete process.env.CERNEYSELECTS_PUBLIC; }
});

test('old signup URLs keep query parameters and converge on the new application URL', async () => {
    const response = await middleware(new Request('https://cerneyselects.com/spotlightsignup/?checkout=success'));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://cerneyselects.com/apply/?checkout=success');
});

test('a public launch flag never opens examples on the reporting or deployment hosts', async () => {
    process.env.CERNEYSELECTS_PUBLIC = 'true';
    try {
        for (const host of ['www.chriscerney.org','cerneydesigns.vercel.app']) {
            const response = await middleware(new Request(`https://${host}/localspotlight/preview/businesses.json`));
            assert.equal(response.status, 401);
        }
    } finally { delete process.env.CERNEYSELECTS_PUBLIC; }
});


test('CerneySelects excludes portfolio, merchandise, tipline and their APIs without changing the reporting domain', async () => {
    process.env.CERNEYSELECTS_PUBLIC = 'true';
    try {
        for (const path of ['/portfolio/', '/store/', '/support/', '/upload/', '/admin/', '/api/create-checkout-session', '/api/admin-store', '/api/tip-upload']) {
            const separate = await middleware(new Request('https://cerneyselects.com' + path));
            assert.equal(separate.status, 404);
            const original = await middleware(new Request('https://www.chriscerney.org' + path));
            assert.equal(original.headers.get('x-middleware-next'), '1');
        }
        const owner = await middleware(new Request('https://cerneyselects.com/admin/spotlight/'));
        assert.equal(owner.headers.get('x-middleware-next'), '1');
        const webhook = await middleware(new Request('https://cerneyselects.com/api/spotlight-webhook', { method: 'POST' }));
        assert.equal(webhook.headers.get('x-middleware-next'), '1');
    } finally { delete process.env.CERNEYSELECTS_PUBLIC; }
});

test('sandbox host stays private even when the production public flag is enabled', async () => {
    process.env.CERNEYSELECTS_PUBLIC = 'true';
    try {
        const anonymous = await middleware(new Request('https://preview.cerneyselects.com/'));
        assert.equal(anonymous.status, 401);
        const authenticated = await middleware(new Request('https://preview.cerneyselects.com/', { headers: { cookie } }));
        assert.equal(authenticated.headers.get('x-middleware-rewrite'), 'https://preview.cerneyselects.com/localspotlight/index.html');
        assert.match(authenticated.headers.get('x-robots-tag'), /noindex/);
    } finally { delete process.env.CERNEYSELECTS_PUBLIC; }
});

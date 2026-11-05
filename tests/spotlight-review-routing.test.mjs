import test from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.ts';
process.env.CERNEYSELECTS_PUBLIC = 'true';
test('review routes permit sanitized banner images while retaining private headers', async () => {
    for (const path of ['/spotlightreview', '/spotlightreview/', '/spotlightreview/index.html']) {
        const response = await middleware(new Request('https://cerneyselects.com' + path));
        const csp = response.headers.get('content-security-policy');
        assert.match(csp, /img-src 'self' data: https:\/\/firebasestorage\.googleapis\.com;/);
        assert.match(csp, /script-src 'self';/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(response.headers.get('cache-control'), /private, no-store/);
        assert.match(response.headers.get('x-robots-tag'), /noindex/);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
});

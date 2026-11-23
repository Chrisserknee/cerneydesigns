import test from 'node:test';import assert from 'node:assert/strict';import middleware from '../middleware.ts';import access from '../api/_lib/booking-auth.js';
process.env.BOOKING_SESSION_SECRET='routing-fixture'.repeat(4);process.env.BOOKING_PASSWORD_HASH='scrypt:salt:hash';process.env.CERNEYSELECTS_PUBLIC='true';
test('public visitors can see the packages while the owner screen and scripts stay gated', async () => {
    for (const path of ['/book','/book/','/book/index.html','/book/app.js']) {
        const response = await middleware(new Request('https://www.chriscerney.org'+path));
        assert.equal(new URL(response.headers.get('x-middleware-rewrite')).pathname, path.endsWith('.js') ? path : '/book/index.html');
        assert.match(response.headers.get('cache-control'), /no-store/);
    }
    for (const path of ['/book/manage/','/book/manage.html']) {
        const response = await middleware(new Request('https://www.chriscerney.org'+path));
        assert.equal(new URL(response.headers.get('x-middleware-rewrite')).pathname, '/book/login.html');
    }
    for (const path of ['/book/manage.js','/book/schedule-editor.js']) {
        assert.equal((await middleware(new Request('https://www.chriscerney.org'+path))).status,401);
    }
});
test('legacy booking links forward to ChrisCerney.org, preserving owner request queries', async () => {
    for (const host of ['cerneyselects.com', 'www.cerneyselects.com']) {
        for (const [path, destination] of [
            ['/book', '/book/'],
            ['/book/index.html', '/book/'],
            ['/book/manage/?request=fixture', '/book/manage/?request=fixture'],
        ]) {
            const response = await middleware(new Request(`https://${host}${path}`));
            assert.equal(response.status, 307);
            assert.equal(response.headers.get('location'), `https://www.chriscerney.org${destination}`);
            assert.match(response.headers.get('cache-control'), /no-store/);
        }
        assert.equal((await middleware(new Request(`https://${host}/book/`, { method: 'POST' }))).status, 404);
        for (const path of ['/book/app.js', '/book/manage.js', '/api/booking']) {
            assert.equal((await middleware(new Request(`https://${host}${path}`))).status, 404);
        }
    }
});

test('booking is unavailable through preview or encoded paths', async () => {
    for (const host of ['preview.cerneyselects.com', 'example.vercel.app']) {
        for (const path of ['/book/', '/book/app.js', '/api/booking', '/api/booking/']) {
            assert.equal((await middleware(new Request(`https://${host}${path}`))).status, 404);
        }
    }
    for (const host of ['cerneyselects.com', 'www.chriscerney.org']) {
        for (const path of ['/%62ook/', '/book%2findex.html', '/api/%62ooking']) {
            assert.equal((await middleware(new Request(`https://${host}${path}`))).status, 400);
        }
    }
});

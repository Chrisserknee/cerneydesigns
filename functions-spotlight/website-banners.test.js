'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { publicAddress, publicUrl, createPublicFetch, candidates, bannerImage, createWebsiteBanners } = require('./website-banners');
const { bannerUrl } = require('./banner-url');
const BUCKET = 'tip-line-8c2d7.firebasestorage.app';
const snapshot = { subscriptionId: 'sub_testbanner', profileHash: 'a'.repeat(64), profile: { website: 'https://example.com/' } };
const raster = (width = 1200, height = 600) => sharp({ create: { width, height, channels: 3, background: '#3478ab' } }).png().toBuffer();

test('rejects private, reserved, translated, malformed and literal network addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.2.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '64:ff9b::0808:0808', '2001:db8::1', '2002:7f00:1::', 'bad']) assert.equal(publicAddress(ip), false, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
    for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://user:pass@example.com/', 'https://example.com:444/', 'https://host.internal/', 'https://example.com\\@localhost/', 'file:///etc/passwd', 'https://localhost/']) assert.throws(() => publicUrl(url), url);
    assert.equal(publicUrl('/photo.webp#ignored', 'https://example.com/home').href, 'https://example.com/photo.webp');
});

function network(replies, addresses = () => [{ address: '8.8.8.8', family: 4 }]) {
    const calls = [], lookups = [];
    const fetch = createPublicFetch({
        lookup: async host => { lookups.push(host); return addresses(host); },
        request(url, options, callback) {
            calls.push(url.href);
            options.lookup(url.hostname, {}, (_e, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
            options.lookup(url.hostname, { all: true }, (_e, result) => assert.deepEqual(result, [{ address: '8.8.8.8', family: 4 }]));
            assert.equal(options.servername, url.hostname); assert.equal(options.agent, false);
            const req = new EventEmitter();
            req.end = () => queueMicrotask(() => { const r = replies.shift(); const res = Readable.from(r.chunks || [Buffer.from('ok')]); res.statusCode = r.status || 200; res.headers = r.headers || { 'content-type': 'text/html' }; callback(res); });
            return req;
        },
    });
    return { fetch: (url, limit = 100) => fetch(url, { limit, signal: AbortSignal.timeout(5000) }), calls, lookups };
}
test('pins DNS and revalidates redirect destinations before connecting', async () => {
    const f = network([{ status: 302, headers: { location: 'https://cdn.example.com/image' } }, { headers: { 'content-type': 'image/png; charset=binary' } }]);
    const r = await f.fetch('https://example.com/');
    assert.equal(r.url, 'https://cdn.example.com/image'); assert.equal(r.type, 'image/png'); assert.deepEqual(f.lookups, ['example.com', 'cdn.example.com']);
    for (const bad of ['http://example.com/', 'https://127.0.0.1/', 'https://cdn.example.com/']) {
        const denied = network([{ status: 302, headers: { location: bad } }], host => host === 'cdn.example.com' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '8.8.8.8', family: 4 }]);
        await assert.rejects(denied.fetch('https://example.com/')); assert.equal(denied.calls.length, 1);
    }
    const mixed = network([], () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await assert.rejects(mixed.fetch('https://example.com/')); assert.equal(mixed.calls.length, 0);
});
test('bounds redirects and compressed, advertised-large and streamed-large responses', async () => {
    const loop = network(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
    await assert.rejects(loop.fetch('https://example.com/')); assert.equal(loop.calls.length, 4);
    for (const reply of [{ status: 404 }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '101' } }, { chunks: [Buffer.alloc(70), Buffer.alloc(70)] }]) await assert.rejects(network([reply]).fetch('https://example.com/'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createPublicFetch({ lookup: async () => [] })('https://example.com', { limit: 100, signal: controller.signal }));
});
test('ranks hero images ahead of social cards, decodes entities and ignores scripts/logos', () => {
    const urls = candidates('<script>"<img src=\"https://evil.example.com/x.jpg\">"</script><img src="/logo.png"><meta property="og:image" content="/social.jpg"><section class="hero"><img src="/large.jpg?a=1&amp;b=2"></section><img src="/regular.jpg"><div style="background:url(https://127.0.0.1/x)"></div>', 'https://example.com');
    assert.equal(urls[0], 'https://example.com/large.jpg?a=1&b=2'); assert.equal(urls[1], 'https://example.com/social.jpg');
    assert.equal(urls.length, 3); assert.ok(urls.every(u => !u.includes('evil') && !u.includes('logo')));
});
test('decodes wide raster images, strips metadata and rejects unsuitable or animated images', async () => {
    const input = await sharp(await raster()).withMetadata({ exif: { IFD0: { Artist: 'Private metadata' } } }).png().toBuffer();
    const output = await bannerImage(Buffer.concat([input, Buffer.from('<script>bad()</script>')]), 'image/png');
    const m = await sharp(output.bytes).metadata();
    assert.equal(m.format, 'webp'); assert.equal(m.width, 1200); assert.equal(m.height, 600); assert.equal(m.exif, undefined); assert.ok(output.bytes.length < 300 * 1024);
    for (const [bytes, type] of [[await raster(600, 600), 'image/png'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.from('not an image'), 'image/jpeg']]) await assert.rejects(bannerImage(bytes, type));
    const png = await raster(); const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
    await assert.rejects(bannerImage(png, 'image/jpeg'));
    await assert.rejects(bannerImage(Buffer.from('<svg><image href="file:///etc/passwd"/></svg>'), 'image/jpeg'));
    await assert.rejects(bannerImage(Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]), 'image/png'));
});
test('SVG wrappers yield only embedded raster photos without rendering SVG or resolving references', async () => {
    const svg = Buffer.from(`<svg><script>throw new Error('do not execute')</script><image href="file:///etc/passwd"/><image href="https://127.0.0.1/internal"/><image href="data:image/png;base64,${(await raster()).toString('base64')}"/></svg>`);
    const image = await bannerImage(svg, 'image/svg+xml');
    assert.equal((await sharp(image.bytes).metadata()).format, 'webp');
    await assert.rejects(bannerImage(Buffer.from('<svg><image href="https://example.com/photo.jpg"/></svg>'), 'image/svg+xml'));
});
function storage() {
    const objects = new Map(); let writes = 0;
    const bucket = { name: BUCKET, file: name => ({
        getMetadata: async () => { if (!objects.has(name)) throw Object.assign(new Error('missing'), { code: 404 }); return [objects.get(name).metadata]; },
        save: async (bytes, options) => { writes++; assert.equal(options.preconditionOpts.ifGenerationMatch, 0); if (objects.has(name)) throw Object.assign(new Error('exists'), { code: 412 }); objects.set(name, { bytes, metadata: options.metadata }); },
    }) };
    return { bucket, objects, writes: () => writes };
}
test('immutable saved copies survive duplicate ingestion without fetching or overwriting', async () => {
    const s = storage(); const png = await raster(); let requests = 0;
    const banners = createWebsiteBanners({ bucket: s.bucket, fetchPublic: async url => { requests++; return url === snapshot.profile.website ? { type: 'text/html', url, bytes: Buffer.from('<img class="hero" src="/wide.png">') } : { type: 'image/png', url, bytes: png }; } });
    const result = await banners.discover(snapshot); const again = await banners.discover(snapshot);
    assert.equal(result.status, 'ready'); assert.equal(result.url, again.url); assert.equal(requests, 2); assert.equal(s.writes(), 1); assert.equal(bannerUrl(result.url, false), result.url); assert.equal(bannerUrl(result.url, true), '');
    assert.equal([...s.objects.keys()][0].includes('sub_testbanner'), false);
    assert.equal(bannerUrl(result.url + '&token=bad', false), '');
    const apiValidator = require('../api/_lib/spotlight-banner-url').bannerUrl;
    assert.equal(apiValidator(result.url, false), result.url); assert.equal(apiValidator(result.url.replace('firebasestorage.googleapis.com', 'evil.example.com'), false), '');
});
test('unusable images return a safe fallback and candidate download count is bounded', async () => {
    const s = storage(); let requests = 0;
    const banners = createWebsiteBanners({ bucket: s.bucket, fetchPublic: async url => { requests++; if (requests === 1) return { type: 'text/html', url, bytes: Buffer.from(Array.from({ length: 20 }, (_, i) => `<img class="hero" src="/${i}.png">`).join('')) }; throw new Error('blocked'); } });
    assert.equal((await banners.discover(snapshot)).status, 'none'); assert.equal(requests, 6); assert.equal(s.writes(), 0);
    await assert.rejects(banners.discover({ ...snapshot, subscriptionId: '../bad' }));
});

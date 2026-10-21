'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createLogoService, decodeInput, sanitizeImage, BUCKET, PREFIX, QUOTA_PATH, MAX_INPUT_BYTES } = require('./logos');
const clientKey = 'a'.repeat(64);
const input = (bytes, mimeType = 'image/png', key = clientKey) => ({ imageBase64: bytes.toString('base64'), mimeType, clientKey: key });
const png = () => sharp({ create: { width: 80, height: 40, channels: 4, background: '#176a43' } }).png().toBuffer();
const code = expected => error => error.code === expected;

function memoryBucket() {
    const files = new Map(); let generation = 0;
    const error = value => Object.assign(new Error('Storage operation failed'), { code: value });
    return {
        name: BUCKET, files, failedLogoWrites: false, beforeDownload: null,
        file(name, options = {}) {
            const bucket = this;
            return {
                async getMetadata() { const item = files.get(name); if (!item) throw error(404); return [{ generation: String(item.generation), size: String(item.data.length) }]; },
                async download() {
                    if (bucket.beforeDownload) { const hook = bucket.beforeDownload; bucket.beforeDownload = null; await hook(); }
                    const item = files.get(name); if (!item || options.generation && String(item.generation) !== String(options.generation)) throw error(404); return [Buffer.from(item.data)];
                },
                async save(data, config) {
                    if (bucket.failedLogoWrites && name.startsWith(PREFIX)) throw error(503);
                    if (String(files.get(name)?.generation || 0) !== String(config.preconditionOpts.ifGenerationMatch)) throw error(412);
                    files.set(name, { data: Buffer.from(data), generation: ++generation, config });
                },
            };
        },
    };
}
const quota = bucket => JSON.parse(bucket.files.get(QUOTA_PATH).data.toString());

test('JPEG, PNG and WebP are decoded, resized and re-encoded to metadata-free WebP', async () => {
    for (const format of ['jpeg', 'png', 'webp']) {
        const bytes = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#734b29' } }).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
        const decoded = decodeInput(input(bytes, 'image/' + format));
        const result = await sanitizeImage(decoded.bytes, decoded.format), meta = await sharp(result.bytes).metadata();
        assert.equal(meta.format, 'webp'); assert.equal(result.width, 256); assert.equal(result.height, 512);
        assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined); assert.equal(meta.orientation, undefined);
    }
});

test('small transparent logos preserve dimensions and alpha, without enlarging', async () => {
    const bytes = await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 0, g: 10, b: 20, alpha: 0.5 } } }).png().toBuffer();
    const image = await sanitizeImage(bytes, 'png');
    assert.equal(image.width, 32); assert.equal(image.height, 16); assert.equal((await sharp(image.bytes).metadata()).hasAlpha, true);
});

test('non-raster inputs, MIME spoofing, noncanonical base64 and missing client identity are rejected', async () => {
    const bytes = await png();
    for (const value of [input(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), input(Buffer.from('<html>bad</html>')), input(bytes, 'image/jpeg'), input(bytes, 'image/svg+xml'), { ...input(bytes), imageBase64: 'data:image/png;base64,' + bytes.toString('base64') }, { ...input(bytes), imageBase64: 'YR==' }, { ...input(bytes), imageBase64: 'AA=AA===' }]) assert.throws(() => decodeInput(value), code('INVALID_LOGO'));
    assert.throws(() => decodeInput(input(bytes, 'image/png', 'raw-ip-address')), code('UPLOAD_FORBIDDEN'));
});

test('the exact byte cap rejects a padded encoding only one decoded byte over 2 MiB', () => {
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.throws(() => decodeInput(input(bytes)), code('LOGO_TOO_LARGE'));
});

test('truncated images, animated WebP, excessive dimensions and excessive pixels fail real decoding', async () => {
    const good = await png();
    await assert.rejects(sanitizeImage(good.subarray(0, 30), 'png'), code('INVALID_LOGO'));
    const frames = Buffer.alloc(2 * 4 * 4, 255); frames.fill(0, 0, 16);
    const animated = await sharp(frames, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    assert.equal((await sharp(animated).metadata()).pages, 2);
    await assert.rejects(sanitizeImage(animated, 'webp'), code('INVALID_LOGO'));
    for (const [width, height] of [[8193, 1], [4001, 4000]]) {
        const big = await sharp({ create: { width, height, channels: 3, background: 'white' } }).png().toBuffer();
        await assert.rejects(sanitizeImage(big, 'png'), code('INVALID_LOGO'));
    }
});

test('animated PNG is explicitly rejected even when libpng reports only its first frame', async () => {
    const { crc32 } = require('node:zlib');
    const images = await Promise.all(['red', 'blue'].map(background => sharp({ create: { width: 2, height: 2, channels: 4, background } }).png().toBuffer()));
    function chunks(bytes) { const out = []; for (let offset = 8; offset < bytes.length;) { const n = bytes.readUInt32BE(offset); out.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + n) }); offset += n + 12; } return out; }
    function chunk(type, data) { const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes; }
    function control(sequence) { const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(2, 8); bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes; }
    const parsed = images.map(chunks), animation = Buffer.alloc(8); animation.writeUInt32BE(2);
    const secondFrame = Buffer.concat([Buffer.from([0, 0, 0, 2]), ...parsed[1].filter(value => value.type === 'IDAT').map(value => value.data)]);
    const apng = Buffer.concat([images[0].subarray(0, 8), chunk('IHDR', parsed[0][0].data), chunk('acTL', animation), chunk('fcTL', control(0)), ...parsed[0].filter(value => value.type === 'IDAT').map(value => chunk('IDAT', value.data)), chunk('fcTL', control(1)), chunk('fdAT', secondFrame), chunk('IEND', Buffer.alloc(0))]);
    assert.equal((await sharp(apng).metadata()).pages, undefined);
    await assert.rejects(sanitizeImage(apng, 'png'), code('INVALID_LOGO'));
});

test('stored objects contain sanitized bytes, random paths and only an individual download token', async () => {
    const bucket = memoryBucket(), service = createLogoService({ bucket });
    const result = await service.upload(input(await png())), url = new URL(result.logoUrl);
    assert.equal(url.origin, 'https://firebasestorage.googleapis.com'); assert.ok(result.logoUrl.length <= 500);
    assert.equal(url.searchParams.get('alt'), 'media'); assert.match(url.searchParams.get('token'), /^[a-f0-9-]{36}$/);
    const name = decodeURIComponent(url.pathname.split('/o/')[1]); assert.match(name, /^_spotlight\/v1\/sandbox\/logos\/[a-f0-9]{48}\.webp$/);
    const stored = bucket.files.get(name); assert.equal(stored.config.metadata.metadata.firebaseStorageDownloadTokens, url.searchParams.get('token'));
    assert.equal(stored.config.preconditionOpts.ifGenerationMatch, 0); assert.equal(stored.config.predefinedAcl, undefined); assert.equal(stored.config.public, undefined);
    assert.equal(stored.config.contentType, 'image/webp'); assert.equal((await sharp(stored.data).metadata()).format, 'webp');
    assert.equal(quota(bucket).storedBytes, result.bytes); assert.equal(quota(bucket).storedObjects, 1);
    assert.equal(bucket.files.size, 2);
});

test('concurrent uploads cannot overrun per-client or object budgets', async () => {
    const bytes = await png();
    for (const limits of [{ hourlyPerClient: 2 }, { storedObjects: 2 }]) {
        const bucket = memoryBucket(), service = createLogoService({ bucket, limits });
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.upload(input(bytes))));
        assert.equal(results.filter(value => value.status === 'fulfilled').length, 2);
        assert.ok(results.filter(value => value.status === 'rejected').every(value => value.reason.status === 429));
        assert.equal(quota(bucket).storedObjects, 2); assert.equal([...bucket.files.keys()].filter(name => name.startsWith(PREFIX)).length, 2);
    }
});

test('global daily attempts apply across clients and reset daily while stored capacity never resets', async () => {
    let clock = 100 * 86400000;
    const bucket = memoryBucket(), service = createLogoService({ bucket, now: () => clock, limits: { dailyGlobal: 1, storedObjects: 2 } }), bytes = await png();
    await service.upload(input(bytes));
    await assert.rejects(service.upload(input(bytes, 'image/png', 'b'.repeat(64))), code('UPLOAD_LIMIT'));
    clock += 86400000; await service.upload(input(bytes));
    clock += 86400000; await assert.rejects(service.upload(input(bytes)), code('UPLOAD_CAPACITY'));
    assert.equal(quota(bucket).storedObjects, 2);
});

test('per-client attempt window resets after an hour and invalid raster attempts consume the budget', async () => {
    let clock = 1000000; const bucket = memoryBucket(), service = createLogoService({ bucket, now: () => clock, limits: { hourlyPerClient: 1 } }), bytes = await png();
    await assert.rejects(service.upload(input(bytes.subarray(0, 30))), code('INVALID_LOGO'));
    assert.equal(quota(bucket).storedBytes, 0); assert.equal(quota(bucket).dayAttempts, 1);
    await assert.rejects(service.upload(input(bytes)), code('UPLOAD_LIMIT'));
    clock += 3600000; await service.upload(input(bytes)); assert.equal(quota(bucket).storedObjects, 1);
});

test('storage quota reserves decoded bytes only and uncertain object failures retain their reservation', async () => {
    const bytes = await png(), bucket = memoryBucket(); bucket.failedLogoWrites = true;
    const service = createLogoService({ bucket, limits: { storedObjects: 1 } });
    await assert.rejects(service.upload(input(bytes)), error => error.code === 503);
    assert.equal(quota(bucket).storedObjects, 1); assert.ok(quota(bucket).storedBytes > 0); assert.equal(bucket.files.size, 1);
    bucket.failedLogoWrites = false; await assert.rejects(service.upload(input(bytes)), code('UPLOAD_CAPACITY'));
    const tiny = memoryBucket(); await assert.rejects(createLogoService({ bucket: tiny, limits: { storedBytes: 1 } }).upload(input(bytes)), code('UPLOAD_CAPACITY'));
    assert.equal(quota(tiny).storedObjects, 0); assert.equal(quota(tiny).storedBytes, 0);
});

test('invalid quota state and storage outages fail closed without storing an image', async () => {
    const bytes = await png(), bucket = memoryBucket(); bucket.files.set(QUOTA_PATH, { generation: 1, data: Buffer.from('{"storedObjects":-1}') });
    await assert.rejects(createLogoService({ bucket }).upload(input(bytes)), /quota record is invalid/); assert.equal(bucket.files.size, 1);
    const unavailable = { name: BUCKET, file() { return { async getMetadata() { throw new Error('unavailable'); } }; } };
    await assert.rejects(createLogoService({ bucket: unavailable }).upload(input(bytes)), /unavailable/);
    assert.throws(() => createLogoService({ bucket: { name: 'wrong-project' } }), /unavailable/);
});

test('generation disappearing during quota download is retried using fresh state', async () => {
    const bucket = memoryBucket(), service = createLogoService({ bucket }), bytes = await png(); await service.upload(input(bytes));
    bucket.beforeDownload = async () => { const old = bucket.files.get(QUOTA_PATH); bucket.files.set(QUOTA_PATH, { ...old, generation: old.generation + 1 }); };
    await service.upload(input(bytes)); assert.equal(quota(bucket).storedObjects, 2);
});

test('real proxy, HMAC gateway, decoder and quota storage compose into one safe upload', async () => {
    const { createHandler } = require('../api/_lib/spotlight-handlers/logo'), { createLogoGateway } = require('./logos-gateway');
    const bucket = memoryBucket(), service = createLogoService({ bucket }), secret = 'composed-logo-test-secret-with-more-than-32-characters', now = 1792228800000;
    const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } });
    const gateway = createLogoGateway({ getSecret: () => secret, makeLogos: () => service, now: () => now });
    const handler = createHandler({ getConfig: () => ({ siteUrl: 'https://preview.example', enabled: false }), getProxyConfig: () => ({ ready: true, secret }), now: () => now, fetchImpl: async (url, options) => {
        const result = response();
        await gateway({ method: options.method, rawBody: Buffer.from(options.body), headers: Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])) }, result);
        return { ok: result.statusCode === 200, status: result.statusCode, json: async () => result.body };
    } });
    const bytes = await png(), result = response();
    await handler({ method: 'POST', headers: { origin: 'https://preview.example', 'content-type': 'application/json', 'x-vercel-forwarded-for': '198.51.100.123' }, body: { imageBase64: bytes.toString('base64'), mimeType: 'image/png' } }, result);
    assert.equal(result.statusCode, 200); assert.equal(result.body.width, 80); assert.equal(result.body.height, 40);
    assert.equal(quota(bucket).storedObjects, 1); assert.doesNotMatch(bucket.files.get(QUOTA_PATH).data.toString(), /198\.51\.100\.123/);
    assert.equal((await sharp([...bucket.files.entries()].find(([name]) => name.startsWith(PREFIX))[1].data).metadata()).format, 'webp');
});


test('live logo objects and quotas are isolated from the sandbox', async () => {
    const bucket = memoryBucket();
    const live = createLogoService({ bucket, live: true });
    const uploaded = await live.upload(input(await png()));
    assert.match(decodeURIComponent(uploaded.logoUrl), /_spotlight\/v1\/live\/logos\//);
    assert.equal(bucket.files.has('_spotlight/v1/live/logo-upload-quota.json'), true);
    assert.equal(bucket.files.has(QUOTA_PATH), false);
});

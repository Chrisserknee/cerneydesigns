'use strict';

const crypto = require('node:crypto');
const sharp = require('sharp');
const BUCKET = 'tip-line-8c2d7.firebasestorage.app';
// Defaults retained for the existing sandbox API and its clients.
const PREFIX = '_spotlight/v1/sandbox/logos/';
const QUOTA_PATH = '_spotlight/v1/sandbox/logo-upload-quota.json';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 2048;
const MAX_OUTPUT_BYTES = 150 * 1024;
const MAX_PIXELS = 16000000;
const MAX_DIMENSION = 8192;
const HOUR = 3600000;
const DAY = 86400000;
const DEFAULT_LIMITS = { hourlyPerClient: 10, dailyGlobal: 200, storedBytes: 100 * 1024 * 1024, storedObjects: 2000 };
const MIME_FORMAT = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
sharp.cache(false);
sharp.concurrency(1);

function fail(message, status = 400, code = 'INVALID_LOGO') { throw Object.assign(new Error(message), { status, code }); }

function decodeInput({ imageBase64, mimeType, clientKey } = {}) {
    if (!/^[a-f0-9]{64}$/.test(clientKey || '')) fail('Upload identification is unavailable.', 403, 'UPLOAD_FORBIDDEN');
    if (!MIME_FORMAT[mimeType] || typeof imageBase64 !== 'string' || !imageBase64) fail('Choose a JPEG, PNG, or WebP image.');
    if (imageBase64.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4) fail('Choose an image no larger than 2 MB.', 413, 'LOGO_TOO_LARGE');
    if (imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)) fail('The image could not be read. Choose it again.');
    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length > MAX_INPUT_BYTES) fail('Choose an image no larger than 2 MB.', 413, 'LOGO_TOO_LARGE');
    if (!bytes.length || bytes.toString('base64') !== imageBase64) fail('The image could not be read. Choose it again.');
    const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
    if (format !== MIME_FORMAT[mimeType]) fail('Choose a valid JPEG, PNG, or WebP image.');
    return { bytes, format };
}

async function sanitizeImage(bytes, expectedFormat) {
    try {
        // libpng exposes only an APNG's first frame, without reporting pages.
        // Check real PNG chunks so animated inputs cannot silently flatten.
        if (expectedFormat === 'png') {
            for (let offset = 8; offset + 12 <= bytes.length;) {
                const length = bytes.readUInt32BE(offset);
                if (length > bytes.length - offset - 12) fail('The PNG image is incomplete. Choose a valid image.');
                const type = bytes.toString('ascii', offset + 4, offset + 8);
                if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('Choose a non-animated JPEG, PNG, or WebP image.');
                if (type === 'IEND') break;
                offset += length + 12;
            }
        }
        const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true });
        const meta = await image.metadata();
        if (meta.format !== expectedFormat || !Number.isSafeInteger(meta.width) || !Number.isSafeInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION || meta.width * meta.height > MAX_PIXELS || (meta.pages || 1) !== 1) fail('Choose a still image up to 8192 pixels per side and 16 megapixels.');
        // Sharp strips metadata by default. Re-encoding also discards trailing
        // active content and accepts only the decoded raster, never an SVG.
        const output = await image.rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85, effort: 4 }).timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
        if (!output.data.length || output.data.length > MAX_OUTPUT_BYTES || output.info.width > 512 || output.info.height > 512) fail('This image is too complex. Choose a simpler logo.', 413, 'LOGO_TOO_LARGE');
        return { bytes: output.data, width: output.info.width, height: output.info.height };
    } catch (error) {
        if (error.code === 'INVALID_LOGO' || error.code === 'LOGO_TOO_LARGE') throw error;
        fail('The image could not be decoded. Choose a valid, non-animated JPEG, PNG, or WebP.');
    }
}

function createLogoService({ bucket, now = Date.now, limits = DEFAULT_LIMITS, live = false }) {
    if (!bucket || bucket.name !== BUCKET || typeof bucket.file !== 'function') throw new Error('Spotlight logo storage is unavailable.');
    const mode = live === true ? 'live' : 'sandbox';
    const PREFIX = `_spotlight/v1/${mode}/logos/`;
    const QUOTA_PATH = `_spotlight/v1/${mode}/logo-upload-quota.json`;
    const bounds = { ...DEFAULT_LIMITS, ...limits };

    async function quotaVersion() {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            let metadata;
            try { [metadata] = await bucket.file(QUOTA_PATH).getMetadata(); }
            catch (error) { if (Number(error.code) === 404) return { generation: 0, data: { day: Math.floor(now() / DAY), dayAttempts: 0, clients: {}, storedBytes: 0, storedObjects: 0 } }; throw error; }
            if (Number(metadata.size) > 65536) throw new Error('Upload quota record is invalid.');
            try {
                const [bytes] = await bucket.file(QUOTA_PATH, { generation: metadata.generation }).download();
                if (bytes.length > 65536) throw new Error('Upload quota record is invalid.');
                const data = JSON.parse(bytes.toString('utf8'));
                if (![data.day, data.dayAttempts, data.storedBytes, data.storedObjects].every(Number.isSafeInteger) || !data.clients || Array.isArray(data.clients) || typeof data.clients !== 'object' || [data.dayAttempts, data.storedBytes, data.storedObjects].some(value => value < 0)) throw new Error('Upload quota record is invalid.');
                return { generation: metadata.generation, data };
            } catch (error) { if (Number(error.code) !== 404) throw error; }
        }
        throw new Error('Upload quota changed repeatedly.');
    }

    async function updateQuota(change) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const { generation, data } = await quotaVersion();
            change(data);
            const bytes = Buffer.from(JSON.stringify(data));
            if (bytes.length > 65536) fail('Uploads are busy. Try again later.', 429, 'UPLOAD_LIMIT');
            try {
                await bucket.file(QUOTA_PATH).save(bytes, { resumable: false, contentType: 'application/json', metadata: { cacheControl: 'private, no-store' }, preconditionOpts: { ifGenerationMatch: generation } });
                return;
            } catch (error) { if (Number(error.code) !== 412) throw error; }
        }
        fail('Uploads are busy. Try again in a moment.', 503, 'UPLOAD_UNAVAILABLE');
    }

    async function consumeAttempt(clientKey) {
        await updateQuota(data => {
            const day = Math.floor(now() / DAY);
            if (data.day !== day) { data.day = day; data.dayAttempts = 0; }
            for (const [key, value] of Object.entries(data.clients)) if (!value || !Number.isSafeInteger(value.startedAt) || value.startedAt + HOUR <= now()) delete data.clients[key];
            const client = data.clients[clientKey] || { startedAt: now(), attempts: 0 };
            if (!Number.isSafeInteger(client.attempts) || client.attempts < 0) throw new Error('Upload quota record is invalid.');
            if (client.attempts >= bounds.hourlyPerClient || data.dayAttempts >= bounds.dailyGlobal) fail('Upload limit reached. Try again later, or use a logo URL.', 429, 'UPLOAD_LIMIT');
            if (data.storedBytes >= bounds.storedBytes || data.storedObjects >= bounds.storedObjects) fail('Logo uploads are temporarily full. Use a logo URL or contact Chris.', 429, 'UPLOAD_CAPACITY');
            client.attempts += 1; data.clients[clientKey] = client; data.dayAttempts += 1;
        });
    }

    async function reserveStorage(bytes) {
        await updateQuota(data => {
            if (data.storedBytes + bytes > bounds.storedBytes || data.storedObjects + 1 > bounds.storedObjects) fail('Logo uploads are temporarily full. Use a logo URL or contact Chris.', 429, 'UPLOAD_CAPACITY');
            data.storedBytes += bytes; data.storedObjects += 1;
        });
    }

    async function upload(input) {
        const { bytes, format } = decodeInput(input);
        await consumeAttempt(input.clientKey);
        const image = await sanitizeImage(bytes, format);
        await reserveStorage(image.bytes.length);
        const filename = PREFIX + crypto.randomBytes(24).toString('hex') + '.webp';
        const token = crypto.randomUUID();
        // Reserve before saving. If a save fails or its response is lost, keep
        // the reservation: capacity remains bounded even if GCS accepted it.
        await bucket.file(filename).save(image.bytes, { resumable: false, validation: 'crc32c', contentType: 'image/webp', metadata: { contentType: 'image/webp', contentDisposition: 'inline; filename="business-logo.webp"', cacheControl: 'public, max-age=31536000, immutable', metadata: { firebaseStorageDownloadTokens: token, spotlight: 'local_spotlight_v1', sanitized: 'webp-v1' } }, preconditionOpts: { ifGenerationMatch: 0 } });
        const logoUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(filename)}?alt=media&token=${token}`;
        return { logoUrl, width: image.width, height: image.height, bytes: image.bytes.length };
    }
    return { upload };
}

module.exports = { createLogoService, decodeInput, sanitizeImage, MAX_INPUT_BYTES, MAX_JSON_BYTES, MAX_PIXELS, MAX_DIMENSION, MAX_OUTPUT_BYTES, DEFAULT_LIMITS, QUOTA_PATH, PREFIX, BUCKET };

'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const { Parser } = require('htmlparser2');
const sharp = require('sharp');
const { bannerUrl } = require('./banner-url');
const BUCKET = 'tip-line-8c2d7.firebasestorage.app';
const HTML_LIMIT = 1024 * 1024, IMAGE_LIMIT = 5 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('Website image is unavailable.'); };

function publicAddress(address) {
    try {
        const ip = ipaddr.parse(address);
        return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3));
    } catch { return false; }
}
function publicUrl(value, base) {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) fail();
    const u = new URL(value, base);
    const host = u.hostname;
    if (u.protocol !== 'https:' || u.username || u.password || u.port || net.isIP(host.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) || /\.(local|localhost|internal|test|invalid|onion|home|lan)$/i.test(host)) fail();
    u.hash = '';
    return u;
}
async function abortable(promise, signal) {
    signal.throwIfAborted();
    let abort;
    try { return await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(new Error('Website request timed out.')); signal.addEventListener('abort', abort, { once: true }); })]); }
    finally { signal.removeEventListener('abort', abort); }
}

function createPublicFetch({ lookup = dns.lookup, request = https.request } = {}) {
    return async function read(value, { limit, signal }) {
        let url = publicUrl(value);
        for (let hop = 0; hop <= 3; hop++) {
            const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
            const addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), stepSignal);
            // Validate every answer and pin the connection to the checked IP.
            if (!addresses.length || addresses.some(a => !publicAddress(a.address) || net.isIP(a.address) !== a.family)) fail();
            const chosen = addresses.find(a => a.family === 4) || addresses[0];
            const result = await new Promise((resolve, reject) => {
                const req = request(url, {
                    method: 'GET', agent: false, family: chosen.family, autoSelectFamily: false,
                    servername: url.hostname, signal: stepSignal,
                    lookup: (_host, opts, cb) => cb(null, opts?.all ? [chosen] : chosen.address, chosen.family),
                    headers: { 'User-Agent': 'CerneySelectsBanner/1.0 (+https://cerneyselects.com)', Accept: 'text/html,image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
                }, res => {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.destroy(); return resolve({ redirect: res.headers.location }); }
                    if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] || 0) > limit) { res.destroy(); return reject(new Error('Website response rejected.')); }
                    let size = 0; const chunks = [];
                    res.on('data', chunk => { size += chunk.length; if (size > limit) { res.destroy(); reject(new Error('Website response too large.')); } else chunks.push(chunk); });
                    res.on('error', reject);
                    res.on('aborted', () => reject(new Error('Website response incomplete.')));
                    res.on('end', () => resolve({ bytes: Buffer.concat(chunks), type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), url: url.href }));
                });
                req.on('error', reject); req.end();
            });
            if (!Object.hasOwn(result, 'redirect')) return result;
            if (hop === 3 || !result.redirect) fail();
            url = publicUrl(result.redirect, url.href); // Revalidate DNS on every redirect.
        }
        fail();
    };
}

function candidates(html, pageUrl) {
    const found = new Map(); let position = 0; const stack = [];
    const add = (value, score) => {
        try { const url = publicUrl(value, pageUrl).href; if (/\b(?:favicon|logo|icon|badge|avatar)\b/i.test(new URL(url).pathname)) return; found.set(url, Math.max(found.get(url) || 0, score)); } catch { /* Ignore unusable website references. */ }
    };
    const parser = new Parser({
        onopentag(name, a) {
            const context = `${a.id || ''} ${a.class || ''} ${a.alt || ''}`;
            const hero = /hero|banner|masthead|cover|background|slideshow/i.test(context) || stack.some(x => x.hero);
            stack.push({ name, hero }); position++;
            if (name === 'meta' && /^(og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(a.property || a.name || '')) add(a.content, 90);
            if (name === 'img' || name === 'source') {
                const score = hero ? 120 : Math.max(10, 65 - position / 10);
                for (const key of ['data-src', 'data-lazy-src', 'src']) if (a[key]) add(a[key], score);
                const sources = (a.srcset || a['data-srcset'] || '').split(',').slice(0, 12).map(s => s.trim().split(/\s+/)).filter(s => s[0]);
                for (const s of sources.sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0)).slice(0, 2)) add(s[0], score + 1);
            }
            if (a.style && /background/i.test(a.style)) for (const m of a.style.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi)) add(m[1], hero ? 125 : 75);
            if (hero && a['data-background-image']) add(a['data-background-image'], 120);
        },
        onclosetag() { stack.pop(); },
    }, { decodeEntities: true });
    parser.end(html);
    return [...found].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([url]) => url);
}

async function bannerImage(bytes, type) {
    if (type === 'image/svg+xml') {
        // Some site builders wrap a hero photo in SVG. Extract only embedded
        // raster bytes; never render SVG or resolve its scripts/files/URLs.
        const embedded = [];
        const parser = new Parser({ onopentag(name, attrs) {
            const value = attrs.href || attrs['xlink:href'] || '';
            if (name === 'image' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
                embedded.push(value);
                embedded.sort((a, b) => b.length - a.length);
                embedded.length = Math.min(embedded.length, 3);
            }
        } }, { xmlMode: true, decodeEntities: true });
        parser.end(bytes.toString('utf8'));
        for (const value of embedded) {
            const comma = value.indexOf(',');
            try { return await bannerImage(Buffer.from(value.slice(comma + 1), 'base64'), value.slice(5, value.indexOf(';'))); } catch { /* Try the next embedded photo. */ }
        }
        fail();
    }
    const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
    // Reject format spoofing before the decoder can select SVG or another loader.
    if (!expected || format !== expected) fail();
    if (format === 'png') {
        // libpng reports only the first APNG frame, so inspect animation chunks.
        for (let offset = 8; offset + 12 <= bytes.length;) {
            const length = bytes.readUInt32BE(offset);
            if (length > bytes.length - offset - 12) fail();
            const chunk = bytes.toString('ascii', offset + 4, offset + 8);
            if (['acTL', 'fcTL', 'fdAT'].includes(chunk)) fail();
            if (chunk === 'IEND') break;
            offset += length + 12;
        }
    }
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 16000000, sequentialRead: true });
    const meta = await image.metadata();
    if (meta.format !== expected || (meta.pages || 1) !== 1 || meta.width < 640 || meta.height < 240 || meta.width > 8192 || meta.height > 8192 || meta.width / meta.height < 1.45 || meta.width / meta.height > 5) fail();
    // Decode/re-encode: no website scripts, SVG, EXIF, or trailing active content.
    const output = await image.rotate().resize({ width: 1200, height: 600, fit: 'cover', withoutEnlargement: true }).webp({ quality: 78, effort: 3 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (!output.data.length || output.data.length > 300 * 1024) fail();
    return { bytes: output.data, width: output.info.width, height: output.info.height };
}

function createWebsiteBanners({ bucket, live = false, fetchPublic = createPublicFetch(), now = Date.now }) {
    if (!bucket || bucket.name !== BUCKET) throw new Error('Banner storage is unavailable.');
    async function discover(snapshot) {
        if (!/^sub_[A-Za-z0-9]+$/.test(snapshot.subscriptionId) || !/^[a-f0-9]{64}$/.test(snapshot.profileHash)) fail();
        const name = `_spotlight/v1/${live ? 'live' : 'sandbox'}/banners/${hash(snapshot.subscriptionId + ':' + snapshot.profileHash)}.webp`;
        const file = bucket.file(name);
        const saved = async () => {
            const [meta] = await file.getMetadata(); const m = meta.metadata || {};
            const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media&token=${m.firebaseStorageDownloadTokens}`;
            if (m.sanitized !== 'banner-webp-v1' || !bannerUrl(url, live) || !/^[a-f0-9]{64}$/.test(m.version || '')) fail();
            return { status: 'ready', url, sourceUrl: m.sourceUrl, version: m.version, width: Number(m.width), height: Number(m.height), discoveredAt: now() };
        };
        try { return await saved(); } catch (e) { if (Number(e.code) !== 404) throw e; }
        const signal = AbortSignal.timeout(12000);
        const page = await fetchPublic(snapshot.profile.website, { limit: HTML_LIMIT, signal });
        if (!['text/html', 'application/xhtml+xml'].includes(page.type)) return { status: 'none' };
        for (const url of candidates(page.bytes.toString('utf8'), page.url).slice(0, 5)) {
            let image, source;
            try {
                signal.throwIfAborted(); source = await fetchPublic(url, { limit: IMAGE_LIMIT, signal }); image = await bannerImage(source.bytes, source.type);
            } catch { if (signal.aborted) break; continue; }
            const version = hash(image.bytes);
            try {
                await file.save(image.bytes, { resumable: false, validation: 'crc32c', contentType: 'image/webp', preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/webp', contentDisposition: 'inline; filename="business-banner.webp"', cacheControl: 'public, max-age=31536000, immutable', metadata: { firebaseStorageDownloadTokens: crypto.randomUUID(), sanitized: 'banner-webp-v1', version, sourceUrl: source.url, width: String(image.width), height: String(image.height) } } });
            } catch (e) { if (Number(e.code) !== 412) throw e; }
            return saved();
        }
        return { status: 'none', discoveredAt: now() };
    }
    return { discover };
}
module.exports = { createWebsiteBanners, createPublicFetch, publicAddress, publicUrl, candidates, bannerImage, HTML_LIMIT, IMAGE_LIMIT };

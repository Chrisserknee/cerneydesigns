'use strict';

// Only our immutable, decoded raster copies can be published as banners.
function bannerUrl(value, live) {
    try {
        const u = new URL(value);
        const path = decodeURIComponent(u.pathname);
        const match = path.match(/^\/v0\/b\/tip-line-8c2d7\.firebasestorage\.app\/o\/_spotlight\/v1\/(live|sandbox)\/banners\/[a-f0-9]{64}\.webp$/);
        if (u.protocol !== 'https:' || u.hostname !== 'firebasestorage.googleapis.com' || u.port || u.username || u.password || u.hash || !match || (typeof live === 'boolean' && match[1] !== (live ? 'live' : 'sandbox')) || u.searchParams.get('alt') !== 'media' || !/^[a-f0-9-]{36}$/.test(u.searchParams.get('token') || '') || [...u.searchParams.keys()].sort().join(',') !== 'alt,token') return '';
        return u.href;
    } catch { return ''; }
}
module.exports = { bannerUrl };

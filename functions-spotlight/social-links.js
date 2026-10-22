(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CerneySelectsSocials = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const platforms = Object.freeze([
        { field: 'instagramUrl', metadata: 'instagram_url', name: 'Instagram', host: 'instagram.com' },
        { field: 'facebookUrl', metadata: 'facebook_url', name: 'Facebook', host: 'facebook.com' },
        { field: 'tiktokUrl', metadata: 'tiktok_url', name: 'TikTok', host: 'tiktok.com' },
    ].map(Object.freeze));
    function normalize(field, value) {
        const platform = platforms.find(item => item.field === field);
        if (!platform) throw new Error('Unknown social platform.');
        const invalid = () => { throw new Error(`Enter a ${platform.name} profile link or @username, or leave it blank.`); };
        if (value === undefined || value === '') return '';
        if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f<>\\]/.test(value)) return invalid();
        let input = value.trim();
        if (!input) return '';
        // A bare handle is convenient on a phone. Full links must belong to the
        // chosen platform; never accept a redirector or an arbitrary website.
        if (/^@?[A-Za-z0-9._-]+$/.test(input) && !input.endsWith('.com')) {
            input = `https://www.${platform.host}/${field === 'tiktokUrl' ? '@' : ''}${input.replace(/^@/, '')}`;
        } else if (/^(?:(?:www|m)\.)?(?:instagram|facebook|tiktok)\.com\//i.test(input)) input = `https://${input}`;
        let url;
        try { url = new URL(input); } catch { return invalid(); }
        const hosts = [platform.host, `www.${platform.host}`, ...(field === 'facebookUrl' ? ['m.facebook.com'] : [])];
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) return invalid();
        let path = url.pathname.replace(/\/$/, '');
        let query = '';
        if (field === 'instagramUrl') {
            if (!/^\/[A-Za-z0-9._]{1,30}$/.test(path) || !/[A-Za-z0-9]/.test(path) || /^\/(?:p|reel|reels|stories|explore|accounts|direct|about|developer|legal|web|share)$/i.test(path)) return invalid();
            path = path.toLowerCase() + '/';
        } else if (field === 'tiktokUrl') {
            if (!/^\/@[A-Za-z0-9._]{1,64}$/.test(path) || !/[A-Za-z0-9]/.test(path)) return invalid();
            path = path.toLowerCase();
        } else if (path === '/profile.php') {
            const id = url.searchParams.get('id');
            if (!/^\d{1,30}$/.test(id || '')) return invalid();
            query = `?id=${id}`;
        } else if (/^\/people\/[A-Za-z0-9._~-]+\/\d{1,30}$/.test(path)) path += '/';
        else {
            if (!/^\/[A-Za-z0-9._-]{1,100}$/.test(path) || !/[A-Za-z0-9]/.test(path) || /^\/(?:l\.php|login(?:\.php)?|logout(?:\.php)?|sharer(?:\.php)?|share(?:\.php)?|dialog|plugins|watch|reel|reels|groups|events|marketplace|help|settings|recover|checkpoint|privacy|policies|photo(?:\.php)?|story\.php)$/i.test(path)) return invalid();
            path += '/';
        }
        return `https://www.${platform.host}${path}${query}`;
    }
    function read(input) {
        const result = {};
        for (const { field } of platforms) {
            const value = normalize(field, input?.[field]);
            if (value) result[field] = value;
        }
        return result;
    }
    function hashEntries(profile, baseFields) {
        // Preserve existing approval hashes when no socials were supplied.
        return [...baseFields.map(field => [field, profile?.[field] || '']),
            ...platforms.filter(({ field }) => profile?.[field]).map(({ field }) => [field, profile[field]])];
    }
    return Object.freeze({ platforms, normalize, read, hashEntries });
}));

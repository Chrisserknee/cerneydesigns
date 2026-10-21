import { next, rewrite } from '@vercel/functions';
import { gate } from './spotlight-gate.cjs';
export const config = { runtime: 'nodejs', matcher: ['/:path*'] };

const previewHeaders = {
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
const directoryCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function requestPath(url: URL) {
    const raw = url.pathname;
    let decoded: string;
    try { decoded = decodeURIComponent(raw); }
    catch { return null; }
    // Reject paths whose meaning could change when a downstream router decodes
    // them again or treats a separator differently. Ordinary encoded filenames
    // on the reporting site (for example spaces) are preserved below.
    if (/%(?:2f|5c)/i.test(raw) || /%[0-9a-f]{2}/i.test(decoded)
        || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('//')) return null;
    const normalized = new URL('https://path.invalid');
    normalized.pathname = decoded;
    return { pathname: normalized.pathname, encoded: decoded !== raw };
}

export default async function middleware(request: Request) {
    const url = new URL(request.url);
    const staging = url.hostname === 'preview.cerneyselects.com';
    const selects = staging || url.hostname === 'cerneyselects.com' || url.hostname === 'www.cerneyselects.com';
    const path = requestPath(url);
    const invalidPath = () => new Response('Invalid request path.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' } });
    if (!path) return invalidPath();
    // These routes have only ASCII filenames. Never let an encoded alias skip a
    // preview/domain check and later resolve to a protected static file.
    const selectsNamespace = /^\/(?:apply|localspotlight|spotlight|spotlightsignup|spotlightreview)(?:\/|$)/.test(path.pathname)
        || /^\/api\/(?:spotlight|spotlight-logo|spotlight-review|spotlight-webhook)\/?$/.test(path.pathname);
    if (path.encoded && (selects || selectsNamespace)) return invalidPath();
    url.pathname = path.pathname;
    const root = url.pathname === '/' || url.pathname === '/index.html';
    const crawlerFile = url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml';
    const publicSite = selects && !staging && process.env.CERNEYSELECTS_PUBLIC === 'true';
    const privateExamples = /^\/localspotlight\/preview(?:\/|$)/.test(url.pathname);
    const retiredExamples = privateExamples && !staging && process.env.CERNEYSELECTS_PUBLIC === 'true'
        && (selects || process.env.VERCEL_ENV === 'production');
    if (retiredExamples) return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' } });
    const spotlightPath = selectsNamespace;
    const selectsAdmin = /^\/admin\/spotlight(?:\/|$)/.test(url.pathname) || ['/admin/style.css', '/api/admin-auth'].includes(url.pathname);
    const policyPath = /^\/(privacy|terms)(?:\/|\/index\.html)?$/.exec(url.pathname);
    if (!selects && !spotlightPath) return next();
    // The new domain contains only Cerney Selects. Other site features stay on
    // chriscerney.org, including their private administration and payment APIs.
    if (selects && !root && !crawlerFile && !spotlightPath && !selectsAdmin && !policyPath && url.pathname !== '/favicon.ico') {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Cerney Selects</title><h1>Page not found</h1><p><a href="/">Explore Cerney Selects</a></p></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    }
    if (selects && url.pathname === '/favicon.ico') return Response.redirect(new URL('/localspotlight/favicon.svg', url), 308);
    // Stripe authenticates this route using its signature over the raw body.
    if (url.pathname === '/api/spotlight-webhook') return next();


    // The reporting homepage and its crawler files continue to serve unchanged.
    if (!selects && (root || crawlerFile)) return next();

    if (['chriscerney.org', 'www.chriscerney.org'].includes(url.hostname) && ['/localspotlight', '/localspotlight/', '/localspotlight/index.html'].includes(url.pathname)) {
        return Response.redirect(new URL('/' + url.search, 'https://cerneyselects.com'), 308);
    }

    if (selects && url.hostname === 'www.cerneyselects.com') {
        url.hostname = 'cerneyselects.com';
        url.protocol = 'https:';
        return Response.redirect(url, 308);
    }
    if (selects && crawlerFile) {
        const robots = url.pathname === '/robots.txt';
        const robotsText = publicSite
            ? 'User-agent: *\nAllow: /\nDisallow: /localspotlight/preview/\nDisallow: /admin/\nDisallow: /api/\nDisallow: /spotlightreview/\nSitemap: https://cerneyselects.com/sitemap.xml\n'
            : 'User-agent: *\nDisallow: /\n';
        const locations = publicSite ? ['https://cerneyselects.com/','https://cerneyselects.com/apply/','https://cerneyselects.com/privacy/','https://cerneyselects.com/terms/'] : [];
        const sitemap = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + locations.map(location => `<url><loc>${location}</loc></url>`).join('') + '</urlset>';
        return new Response(robots ? robotsText : sitemap, {
            headers: { ...previewHeaders, 'Content-Type': robots ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8' },
        });
    }
    if (selects && ['/index.html', '/localspotlight', '/localspotlight/', '/localspotlight/index.html'].includes(url.pathname)) {
        url.pathname = '/';
        return Response.redirect(url, 308);
    }

    if (selects && ['/spotlightsignup', '/spotlightsignup/', '/spotlightsignup/index.html', '/apply/index.html'].includes(url.pathname)) {
        url.pathname = '/apply/';
        return Response.redirect(url, 308);
    }
    // Example workflows remain gated on staging and preview deployments.
    if (!publicSite || privateExamples) {
        const blocked = await gate(request);
        if (blocked) return blocked;
    }
    if (selects && policyPath) {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
        const canonicalPath = `/${policyPath[1]}/`;
        if (url.pathname !== canonicalPath) {
            url.pathname = canonicalPath;
            return Response.redirect(url, 308);
        }
        url.pathname = `/localspotlight/${policyPath[1]}.html`;
        return rewrite(url, { headers: { ...(publicSite ? { 'Cache-Control': 'no-cache' } : previewHeaders), 'Content-Security-Policy': directoryCsp } });
    }
    if (selects && root) {
        if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
        url.pathname = publicSite || staging ? '/localspotlight/index.html' : '/localspotlight/preview/index.html';
        return rewrite(url, { headers: { ...(publicSite ? { 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'index, follow' } : previewHeaders), 'Content-Security-Policy': directoryCsp } });
    }
    if (['/apply', '/apply/'].includes(url.pathname)) {
        url.pathname = '/spotlightsignup/index.html';
        return rewrite(url, { headers: { ...(publicSite ? { 'Cache-Control': 'no-store' } : previewHeaders), 'Content-Security-Policy': directoryCsp.replace("img-src 'self' data: https:", "img-src 'self' data: blob: https:") } });
    }
    return next({ headers: publicSite && !privateExamples ? { 'Cache-Control': 'no-store' } : previewHeaders });
}

import { next, rewrite } from '@vercel/functions';
import { gate } from './spotlight-gate.cjs';
export const config = { runtime: 'nodejs', matcher: ['/:path*'] };

const previewHeaders = {
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
const directoryCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export default async function middleware(request: Request) {
    const url = new URL(request.url);
    const staging = url.hostname === 'preview.cerneyselects.com';
    const selects = staging || url.hostname === 'cerneyselects.com' || url.hostname === 'www.cerneyselects.com';
    const root = url.pathname === '/' || url.pathname === '/index.html';
    const crawlerFile = url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml';
    const publicSite = selects && !staging && process.env.CERNEYSELECTS_PUBLIC === 'true';
    const privateExamples = /^\/localspotlight\/preview(?:\/|$)/.test(url.pathname);
    const spotlightPath = /^\/(?:apply|localspotlight|spotlight|spotlightsignup|spotlightreview)(?:\/|$)/.test(url.pathname)
        || /^\/api\/(?:spotlight|spotlight-logo|spotlight-review|spotlight-webhook)\/?$/.test(url.pathname);
    const selectsAdmin = /^\/admin\/spotlight(?:\/|$)/.test(url.pathname) || ['/admin/style.css', '/api/admin-auth'].includes(url.pathname);
    if (!selects && !spotlightPath) return next();
    // The new domain contains only CerneySelects. Other site features stay on
    // chriscerney.org, including their private administration and payment APIs.
    if (selects && !root && !crawlerFile && !spotlightPath && !selectsAdmin && url.pathname !== '/favicon.ico') {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — CerneySelects</title><h1>Page not found</h1><p><a href="/">Explore CerneySelects</a></p></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
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
        const locations = publicSite ? ['https://cerneyselects.com/','https://cerneyselects.com/apply/'] : [];
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
    // Launching the directory never publishes the example data or preview controls.
    if (!publicSite || privateExamples) {
        const blocked = await gate(request);
        if (blocked) return blocked;
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

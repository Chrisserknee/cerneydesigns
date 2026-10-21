import { next, rewrite } from '@vercel/functions';
import { gate } from './spotlight-gate.cjs';
export const config = { runtime: 'nodejs', matcher: ['/','/index.html','/robots.txt','/sitemap.xml','/localspotlight/:path*','/spotlight/:path*','/spotlightsignup/:path*','/spotlightreview/:path*','/api/spotlight/:path*','/api/spotlight-logo/:path*','/api/spotlight-review/:path*'] };

const previewHeaders = {
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
const directoryCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export default async function middleware(request: Request) {
    const url = new URL(request.url);
    const selects = url.hostname === 'cerneyselects.com' || url.hostname === 'www.cerneyselects.com';
    const root = url.pathname === '/' || url.pathname === '/index.html';
    const crawlerFile = url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml';

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
        return new Response(robots ? 'User-agent: *\nDisallow: /\n' : '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', {
            headers: { ...previewHeaders, 'Content-Type': robots ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8' },
        });
    }
    if (selects && ['/index.html', '/localspotlight', '/localspotlight/', '/localspotlight/index.html'].includes(url.pathname)) {
        url.pathname = '/';
        return Response.redirect(url, 308);
    }

    const blocked = await gate(request);
    if (blocked) return blocked;
    if (selects && root) {
        url.pathname = '/localspotlight/index.html';
        return rewrite(url, { headers: { ...previewHeaders, 'Content-Security-Policy': directoryCsp } });
    }
    return next({ headers: previewHeaders });
}

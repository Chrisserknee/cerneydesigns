import { next } from '@vercel/functions';
import { gate } from './spotlight-gate.cjs';
export const config = { runtime: 'nodejs', matcher: ['/localspotlight/:path*','/spotlight/:path*','/spotlightsignup/:path*','/spotlightreview/:path*','/api/spotlight/:path*','/api/spotlight-logo/:path*','/api/spotlight-review/:path*'] };
export default async function middleware(request: Request) { return await gate(request) || next({headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'}}); }

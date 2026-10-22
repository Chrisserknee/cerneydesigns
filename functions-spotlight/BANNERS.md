# Website banners

A verified initial $100 payment creates a private application. After its review billing hold is confirmed, `website-banners.js` checks the submitted homepage for a wide hero/banner/background image or social card. It stores one sanitized copy and the source in the private review record before the review email is sent.

The owner review page previews that image behind the submitted logo. Approval explicitly includes or omits the previewed version. Publication binds the frozen banner URL to the same profile hash as the listing approval. A declined, pending, unpaid, reversed-payment, or changed-profile listing remains subject to the existing publication checks. An old approval is never reopened automatically.

## Retrieval boundaries

- HTTPS with normal certificate verification; public DNS names only, no credentials or custom ports.
- Every DNS address must be public. The HTTPS connection is pinned to a checked address while retaining TLS hostname verification. Each redirect is checked again; maximum three redirects.
- No browser, page JavaScript, linked stylesheet loading, or SVG rendering. SVG wrappers may supply embedded JPEG/PNG/WebP bytes; external SVG references and executable content are ignored.
- HTML at most 1 MiB; image source at most 5 MiB. At most five candidates and 12 seconds of network retrieval, with an eight-second limit per request. Raster conversion has a five-second timeout.
- Still JPEG/PNG/WebP, at most 16 megapixels and 8192 pixels per side; minimum 640×240 and landscape ratio 1.45–5. Animated images are rejected.
- Output is a metadata-free WebP, at most 1200×600 and 300 KiB. Storage uses an immutable object keyed by subscription/profile hash, creation preconditions, and an unguessable download token. Live and sandbox namespaces are separate.
- The public API accepts only those storage URLs for the matching mode and approved profile. Candidate URLs are never accepted from the applicant or review POST.

This follows the DNS validation and redirect considerations in the [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Missing, blocked, unsupported, or failed website images produce the standard logo background and never prevent review or approval. The owner can omit an unsuitable image. JavaScript-only sites and pure vector banners may have no usable candidate.

## Checks

`node --test functions-spotlight/*.test.js tests/spotlight*.test.js`

Banner tests cover private/reserved addresses, DNS pinning, redirect revalidation, response limits, safe embedded raster extraction, animation rejection, metadata stripping, storage reuse, verified-payment gating, owner inclusion/omission, version checks, and publication profile binding. Browser verification uses a synthetic application with no Stripe mutations or outbound email.

# chriscerney.org — project context

Site for Chris Cerney, a Central Coast (Monterey County, CA) local-news reporter: portfolio, tipline / "Submit a Story" intake, support page, and a small sticker store. Owner-operated; edits are usually small, direct content or UX requests.

This context was carried over from the Codex "Website Editor" chats (June–Sept 2026). This repo is **public** — never write secrets, customer names/addresses, or private Drive links into it.

## Stack and deployment

- Static HTML/CSS/JS. No build step and no root `package.json`.
- Repo: `github.com/Chrisserknee/cerneydesigns`, branch `main`. Vercel project `cerneydesigns` auto-deploys `main` to chriscerney.org (the apex 307-redirects to `www.chriscerney.org`; use `curl -L` when checking). Vercel serverless functions live in `api/`.
- Firebase project `tip-line-8c2d7` (see `.firebaserc`): Storage receives tip uploads; Cloud Functions in `functions/` (Node 22) are `notifyOnTip` (on upload) and `retryTipDeliveries` (five-minute retry).
- Uploads are delivered to the owner's Google Drive through a Google Apps Script bridge (`upload/drive-bridge-apps-script.gs`, deployed separately in Apps Script; last known production version 10). Firebase transfers files into resumable Drive uploads and verifies size and checksum before marking delivery complete.
- Push alerts use the private Cerney Tips Home Screen app through Web Push. NTFY has been removed from tip delivery. Trusted tip devices have no scheduled server expiry; sign-out revokes access. Device cookies renew on use. Drive links become available after independent media verification, before bridge summary finalization.
- Security headers and a strict CSP are in `vercel.json` (`script-src 'self' https://www.gstatic.com`, and so on). Adding any third-party script, image host, or connect target means updating the CSP too. `/admin/*` is noindex and no-store.

## Layout

| Path | What |
|---|---|
| `index.html`, `script.js`, `styles.css` | Homepage; `script.js` also drives portfolio tab filtering |
| `portfolio/` | Portfolio. Tabs are `.portfolio-tab` buttons matched to `.portfolio-category[data-category]`. Reporter Packages is newest-first with real dates; each card uses the Instagram thumbnail and links to the post |
| `upload/` | Tipline upload page + Apps Script bridge |
| `submit-story/` | "Submit a Story" wizard, with photo/video/document upload |
| `merchandise/` | Store page and `catalog.js` (prices, variants, sold-out flags) |
| `api/` | Vercel functions: Stripe checkout session create/status, inventory, merch sales feed, admin auth/store |
| `admin/` | Password-protected inventory/sales admin |
| `functions/` | Firebase Cloud Functions + tipline helpers |
| `support/`, `gofundme/` | Support pages |
| `tests/`, `functions/*.test.js`, `upload/upload.test.cjs`, `submit-story/submit-story.test.cjs` | Node built-in test runner |

## Commands

```bash
cd functions && npm test                # 29 tests: functions, Drive delivery, upload, submit-story
node --test tests/*.test.js             # 15 tests: api security, admin store, sales feed (glob the files; passing the directory fails)
```

- Deploy: pushing `main` deploys the site. Functions need `firebase deploy --only functions`. The Firebase CLI is not installed on this machine yet and needs `firebase login`.
- `git push` needs credentials. Codex worked around missing credentials by publishing through the GitHub API, so local clones drifted behind `origin/main`. **Always `git fetch` and check `origin/main` before editing.**
- After any deploy, verify the live site on mobile and desktop widths, not just locally.

## Configuration (names only, values are never in the repo)

- Vercel env: `STRIPE_SECRET_KEY`, `SITE_URL`, `MERCH_ORDERS_PAUSED`, `CHECKOUT_ENABLED`, `CHECKOUT_ACCOUNT_APPROVED`, `INVENTORY_TRACKING_ENABLED`, `INDIVIDUAL_CHECKOUT_OVERRIDE`, `STRIPE_AUTOMATIC_TAX`, `STRIPE_ALLOW_PROMOTION_CODES`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`.
- Firebase secrets: `DRIVE_BRIDGE_URL`, `DRIVE_BRIDGE_TOKEN`, `NTFY_TOPIC`.
- Never print or commit these. Customer order data (names, addresses) lives in Stripe only.

## Current state (as of 2026-09-28)

- **Merch orders are paused** (backend returns `ORDERS_PAUSED`). Store page shows a prominent pause notice. Only the "Mystery Colors" Supporter Bundle ($29.99 + $1.99 shipping) is featured, with purchasing disabled. Individual stickers show sold out; the sold-out gold holographic finish stays viewable with a red sold-out banner. Fulfillment is tracked in the backend through the orders shipped so far. The rest wait on more sticker inventory. Sticker art is by Talpaworks and the merch page credits and links his Instagram.
- **Tipline repair shipped 2026-09-27** (commits `d7784fe`..`9482297`): progress stays under 100% until finalized, retries keep completed files, Drive delivery resumes and is verified. The earlier failed uploads were recovered into Drive.
- Sponsor banner: the alwaysremember.io ad was removed from the tipline and site. Confirm the current banner state before touching sponsor areas.

## Owner preferences (from past sessions)

- Use the owner's exact wording for copy. Keep edits narrowly scoped.
- Match the site's look. Blue accent overall; salmon (not orange) on latest-coverage buttons and the tipline. Subtle holographic touches on the merch page. Text and graphics should look human-made and not AI-generated. Do not use image generation for functional artifacts like order sheets.
- Whole sponsor banners are clickable, not just the text.
- Portfolio: newest first, with dates. Leave out the Santa Cruz LGBTQ protest report.
- Prefer background/headless verification so the owner can keep using their Mac.

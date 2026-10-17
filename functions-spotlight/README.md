# Local Spotlight moderation

This Firebase codebase is isolated from the existing Tip Line functions. It accepts sandbox Stripe keys only and stores private application records under `_spotlight/v1/sandbox/applications/` in the existing `tip-line-8c2d7.firebasestorage.app` bucket. It never writes the sponsorship ledger.

`spotlightModerationApi` accepts JSON POSTs signed by the Vercel gateway. The signature is HMAC-SHA256 over the timestamp, a period, and the exact raw JSON bytes. Headers are `X-Spotlight-Timestamp` and `X-Spotlight-Signature`; timestamps expire after 60 seconds. Review reads do not make a decision. Decisions require an explicit confirmation and a valid signed review capability.

`retrySpotlightModeration` runs every five minutes. Storage uses immutable generation reads and conditional writes, so concurrent decisions cannot overwrite each other. Work leases and email receipts survive process restarts. Email jobs remain queued while sending is disabled.

The review deadline is two days after the initial payment. Missing that deadline sends an owner reminder; it never approves the listing automatically. A pending application's review link can be renewed once after seven days, with a final owner attention alert if the replacement expires. Refunds requiring action or three failed refund attempts notify the owner while the worker continues checking for a confirmed refund. A refund confirmation email is sent only after the full $100 refund succeeds.

Required Firebase secrets:

- `SPOTLIGHT_MODERATION_PROXY_SECRET`: matches the Vercel Preview variable of the same name.
- `SPOTLIGHT_REVIEW_SECRET`: signs private review links and stays in Firebase.
- `SPOTLIGHT_STRIPE_SECRET_KEY`: dedicated restricted sandbox runtime key.
- `SPONSORSHIP_RESEND_API_KEY`: existing domain-scoped sending credential.

Non-secret parameters are `SPOTLIGHT_PRICE_ID`, `SPOTLIGHT_SITE_URL`, and `SPOTLIGHT_EMAIL_ENABLED` (default false). The local `.env.tip-line-8c2d7` parameter file is ignored by Git. Keep the site URL on the protected preview while testing. Review emails never contain a Vercel protection credential.

This moderation codebase needs Customers, Invoices, Prices, and Payment Intents read access, plus Subscriptions and Charges and Refunds write access. The website's additional Customers, Checkout, and webhook permissions remain configured on the same restricted sandbox key. Test the real refund flow before enabling customer checkout.

Run tests from this directory with `npm test`. Deploy from the repository root using the separate configuration and exact function targets:

```sh
firebase deploy --config firebase.spotlight.json \
  --only functions:spotlight:spotlightModerationApi,functions:spotlight:retrySpotlightModeration \
  --project tip-line-8c2d7
```

Add `--dry-run` to validate the plan. Do not use `--force` or an unscoped functions deployment. This codebase and its configuration are excluded from Vercel static uploads.

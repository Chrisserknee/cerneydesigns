# Private member services

Public signup remains **Local Legend, $100/month**. `SPOTLIGHT_MEMBER_EXTRAS_ENABLED=true` shows the private options only after the server verifies the member's owned, paid base subscription. Approved, published, continuing membership is required to request or purchase a service. A lapsed member can still manage or cancel an existing add-on.

## Packages and approval

- Featured specialty: **$150/month extra**, month to month, no setup fee or video. One agreed specialty across all Monterey County. Other businesses in that specialty can still have ordinary listings.
- Mustache Stamp: **$150/month extra plus $500 once**, one-minute video with Chris, monthly analytics and the same countywide featured position. The premium portion has a three-month minimum ($450); it then continues monthly. The existing $100 listing remains separate and must stay active for featured display. These are alternative featured upgrades, never stacked.
- Cerney Spotlight: a separate, one-time video project, quoted from **$1,000**. The final amount and scope are approved before checkout. The package includes a creative two-minute video with Chris, Instagram collaboration and social distribution.

Requests do not charge or reserve availability. Chris receives a signed private review link and confirms the agreed specialty or video scope and price. The member receives a quote, valid seven days, and separately consents before Stripe checkout. Owner links expire after 30 days and are carried in URL fragments, removed from browser history on page load. Use consistent specialty names: case/punctuation normalize automatically, but synonyms require owner review.

Video production and monthly reporting are fulfilled by Chris. The system sends purchase notifications; it does not produce videos or generate analytics reports.

## Billing and release controls

Purchases require both Vercel `SPOTLIGHT_MEMBER_BILLING_ENABLED=true` and the corresponding Firebase parameter (`SPOTLIGHT_MEMBER_BILLING_ENABLED` for sandbox; `CERNEYSELECTS_MEMBER_BILLING_ENABLED` for live). These default false. Sandbox and production have separate credentials, storage and fixed prices. Never put test credentials in production.

Firebase additionally requires `*_FEATURED_PRICE_ID`, `*_MUSTACHE_PRICE_ID` and `*_SETUP_PRICE_ID`, prefixed `SPOTLIGHT` or `CERNEYSELECTS`. The first two must be active USD $150/month licensed prices; setup must be active USD $500 one-time. Hosted Checkout uses the existing member's customer, separate add-on subscriptions, fixed server prices and explicit consent. Spotlight uses its approved one-time quote. The base price and subscription items remain unchanged. Separate subscriptions may have different renewal dates.

The standalone add-on cancels at its paid period end. Mustache uses a Stripe subscription schedule for three monthly add-on installments; voluntary cancellation during that minimum takes effect at its end. Payment failure, refund or dispute removes featured eligibility and stops add-on collection without a final invoice or proration. Base cancellation prevents new add-on purchases; existing standalone renewal stops, while a valid Mustache minimum is retained. Cancellation remains available through the original member browser even after base membership lapses.

## Storage, retries and verification

HMAC-authenticated backend requests use private GCS `member-extras/` and `member-slots/` namespaces under `_spotlight/v1/sandbox/` or `_spotlight/v1/live/`. No private tokens, email addresses or payment identifiers are returned publicly. Concurrent checkout attempts use atomic specialty reservations and deterministic Stripe idempotency keys. A checkout holds its specialty until Stripe confirms expiration or cancellation; it is not freed solely because a local timer expired. Uncertain attempts older than the 23-hour deduplication safety window need manual review.

Signed webhooks, member refreshes and the five-minute worker reconcile canonical Checkout, subscription, invoice, payment, charge and refund state. Public featured display requires a fresh paid base, matching paid add-on and its owned specialty reservation. Duplicate and delayed events cannot activate an unpaid service or overwrite a replacement quote.

Emails use immutable payloads, generation-based CAS leases and provider idempotency keys. Retry after failures; do not blindly resend an uncertain delivery past the provider's deduplication window. Inspect records marked for attention. Email provider acceptance is different from confirmed inbox delivery.

Release checks include the targeted API/moderation/billing tests, real separate-sandbox checkout amounts, actual payment and cancellation behavior, private owner review, mobile layout and unauthenticated access denial. Keep purchase flags false until the checkout acceptance checks are complete. Never charge a live customer to verify a deployment.

The current browser cookie provides website member access. Stripe's email sign-in opens billing management; it does not sign someone into this website on a different device. Cross-device website recovery is not implemented. Keep a support path available for expired browser sessions and review links.

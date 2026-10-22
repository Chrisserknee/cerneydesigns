# Private member enquiries

The public application remains one $100/month subscription. `SPOTLIGHT_MEMBER_EXTRAS_ENABLED=true` enables the optional services in the management section only after the server verifies an owned, currently paid base subscription. An initial moderation hold does not hide offers from a paid applicant, but an approved, published, continuing listing is required to send a request. Refunded, disputed, unpaid, canceled and mismatched-account records fail closed.

This release implements **enquiries and confirmation emails**, not additional checkout, automatic upgrades, reservations or analytics collection. Do not describe a saved enquiry as a purchased or activated service. The three cards explain the proposed prices and deliverables. Public signup does not contain those cards or prices.

Requests are routed through the existing HMAC-authenticated moderation gateway into separate private GCS namespaces: `_spotlight/v1/sandbox/member-extras/` and `_spotlight/v1/live/member-extras/`. The backend obtains the business name and email from the owned Stripe subscription/customer. It accepts no client-supplied customer, price, payment or subscription identifier.

One featured request (Mustache Stamp or featured-only) and one Spotlight enquiry may be pending per member. Changed or duplicate enquiries are handled by replying to the confirmation email. CAS storage plus fixed email payloads and provider idempotency keys prevents duplicate processing. The existing five-minute scheduled worker retries queued delivery. After an uncertain delivery exceeds the provider deduplication window, the job enters `attention`; inspect the receipt before resending. No message body or credentials should be logged.

## Before enabling purchases

- Confirm whether exclusivity covers an agreed city or all Monterey County.
- Confirm whether featured-only's additional $150/month has the three-month minimum. Mustache Stamp already requires three months.
- Agree a precise specialty and confirm availability before making a payment offer. Exclusivity covers the featured position, not all directory listings.
- Implement atomic reservation and expiry, approved quotes, separate explicit payment consent, billing/cancellation enforcement, refunds and webhook reconciliation, and actual analytics/report delivery.
- Keep Mustache Stamp at **$250/month total**, not $250 on top of the existing $100. The $500 setup fee is one-time. Featured-only has no video setup fee. Spotlight starts at $1,000 and requires a final project quote.
- Verify new charges and renewals in the separate Stripe sandbox before creating live charge paths. Never put test keys into production.

The current browser cookie provides member access. Stripe's email sign-in opens billing management; it does not sign the user into this website on another device. Cross-device website access needs a separate secure recovery implementation before it can be promised.

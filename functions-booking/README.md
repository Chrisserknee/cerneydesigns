# Cerney Selects private video booking

Independent Firebase codebase: `cerney-booking`, project `tip-line-8c2d7`, region `us-west1`.
Deploy only with `firebase deploy --config firebase.booking.json --only functions:cerney-booking --project tip-line-8c2d7` from repository root. Never substitute the unrelated default Firebase configuration.

`BOOKING_MODE` selects isolated GCS state under `_cerney-booking/v1/{sandbox|live}/state.json`. The Stripe key mode must match. `BOOKING_RECURRING_ENABLED` stays false until real sandbox invoice, payment, and cancellation checks pass. `BOOKING_EMAIL_ENABLED` defaults false. Do not enable or dispatch accumulated notification jobs during setup/testing. Review and remove synthetic outbox jobs before any future enabling.

Secrets: BOOKING_PROXY_SECRET, BOOKING_STRIPE_SECRET_KEY, BOOKING_STRIPE_WEBHOOK_SECRET, SPONSORSHIP_GOOGLE_CREDENTIALS, SPONSORSHIP_RESEND_API_KEY. Vercel needs BOOKING_PROXY_SECRET, BOOKING_PASSWORD_HASH (scrypt), BOOKING_SESSION_SECRET, BOOKING_ENABLED. No secret values belong in source control.

Stripe events: invoice.paid, invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted. Endpoint: cerneyBookingStripeWebhook. Requests require gateway HMAC; owner actions also require existing site administrator authentication at Vercel. Shared booking password protects /book and all booking operations; private request tokens identify individual bookings.

Owner settings start paused. Recovered presets are reviewable drafts, with explicit approval of agreement terms before opening requests. Calendar changes carry no attendees and use sendUpdates=none. Stripe invoices are finalized with auto_advance=false; payments are confirmed only through canonical Stripe data and signed webhook/reconciliation.

Run `npm test` for routing, authentication, workflow, provider, and payment-invariant tests. Real sandbox tests must separately exercise calendar holds, invoice creation, payment confirmation, monthly cancellation, and three-month end dates. No live charges or client invitations are needed for verification.

# Community Help publication standard

Before marking a public card reviewed:

1. Identify the actual service operator. Cross-check a government agency, regulator, funding partner or established service network; for a public agency, use its official service page.
2. Read the provider's specific current service instructions. Record who qualifies, area served, costs, referral or appointment requirements and a usable next step. Check recipient instructions, not donation or administrative contacts.
3. Look for evidence of services delivered. Attribute provider-reported counts and distinguish them from independent evaluation. If only program recognition or a service description is available, say so; never invent a success rate or imply proven individual outcomes.
4. Check the exact action destination. A search snippet or old indexed page does not establish a working current route. An access-denied response is inconclusive; a broken destination or conflicting instructions require investigation or a hold.
5. Record the findings, supporting URL, limits and evidence type in `reviews.json`, bound to the exact card fingerprint. Public-source review is not a phone call, field visit or confirmation of current stock, funding or openings.
6. Keep image text short and actionable. Put eligibility and practical limits in details. Show referrals, applications and waitlists as such. Do not promise treatment, benefits, housing, a job or immediate help.
7. Preserve the original event end time. Use short review periods for changing resources. Changes invalidate the review; refresh must not silently renew it. Move unresolved cards to `needsReview` so they cannot be selected or exported as current.

The catalog checks enforce that every card has a matching research record. They do not perform factual verification or prove effectiveness. A human source review is required before writing or renewing that record. Feedback is a lead to investigate, not automatic proof.

Run `node --test tests/community-help.test.mjs` before publishing. Sync the bundled native fallback whenever shipping a binary. Existing clients receive reviewed catalog changes through the public catalog refresh.

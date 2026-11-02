# Founder-only Live checkout and cancellation acceptance

Base web commit: `19518d920ac89125b1782206e9162eaed71f5ed9`.
Worker remains compatible at `ac0a877c4775aadefbc076294f7d171525e82afc`.

## Minimal founder pilot

One optional server-only, non-secret configuration pin:

```text
DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256=<lowercase SHA-256 of the verified founder Google subject>
DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED=false
```

The existing production founder account was independently verified read-only during implementation:
it has a verified Gmail-authoritative Google subject and an active session.
The digest was computed inside the running service; raw subjects, session tokens and credentials
were neither returned nor published. No production configuration was changed.

The email identifies the existing founder record operationally; it is NOT an authorization rule.
Future configuration must use the subject digest derived from that verified record, never a digest
of the email, subscriber UUID, a supplied browser value or another account's subject.
The canonical digest is held in the implementation session's verification evidence; it is not
hardcoded into the repository. Re-derive it read-only from the same verified identity if needed.

The existing account button and POST `/api/billing/dodo/customer-checkout` are reused.
With the pilot pin present:

- Only explicit Live Mode, valid lowercase 64-character digest and public checkout=false are allowed.
- Invalid/missing pilot configuration fails closed. Test Mode does not gain an exception.
- A present pilot pin also blocks the endpoint if public checkout is accidentally enabled.
- The existing secure cookie, unexpired/unrevoked session and verified Google database identity
  are required. A server-derived subject digest is compared in constant time.
- Anonymous and other authenticated accounts are rejected before checkout reservation or provider calls.
- Email changes do not move founder privilege to a different Google subject.
- Caller-supplied email, product, quantity, subscriber ID, subject, headers and browser flags are ignored.
- Existing explicit-origin validation, Live pins, quantity=1, owner correlation, pending/active
  duplicate protection and uncertain-outcome handling remain authoritative.
- Webhook signature/identity validation, confirmed paid periods, quota enforcement and refunds are unchanged.

Removing the pilot pin disables the exception when the public flag remains false. There is no
second public endpoint, new database field, schema migration, UI workflow or infrastructure.
The existing pre-checkout refund disclosure remains attached to the existing button.

## Cancellation findings

Official API: https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions
documents `cancel_at_next_billing_date=true` as retaining activity through the billing period.
It exposes the confirmed scheduling flag and documents no 48-hour API cutoff. The existing code
sends this flag only, validates the active/scheduled provider response and exact paid period,
and never marks success from a request alone. No cancellation code or public policy was changed.

Published buyer terms: https://dodopayments.com/legal/buyer-terms still describe an advance-contact
window of at least 48 hours. That wording does not by itself establish an API cutoff.
The primary remains anytime authenticated self-service cancellation, effective at the paid-period end.

Focused mocked tests exercised confirmed cancellation 47 hours, 1 hour and 1 minute before renewal,
plus rejection, transport uncertainty and cross-account denial. Confirmed responses preserve paid
access; rejected/uncertain responses never claim renewal has stopped. These are synthetic tests,
NOT genuine Dodo acceptance. Real late-cancellation, terminal expiry and successful renewal remain
launch risks until separately authorized and verified with signed events and database evidence.

## Conditional smallest fallback — not activated by this change

If genuine provider behavior requires advance-contact handling, use existing support at
`cliponauthq@gmail.com` and the provider's documented contact route. Do not automatically reject
late requests or impose a new local 48-hour restriction. Preserve pending/uncertain state and
already-paid access; never promise renewal is stopped until provider confirmation.

Suggested wording only if that fallback is genuinely required:

> You can request cancellation anytime in your account. If it is not confirmed, contact
> cliponauthq@gmail.com promptly. Where Dodo requires advance-contact handling, its process asks
> for contact at least 48 hours before renewal. We still review later requests, but renewal is not
> confirmed stopped until the provider confirms it. Already-paid access remains through its verified end.

No support message, provider mutation or public-policy change was made for this fallback.

## Validation and next approval

- 14/14 focused isolated PostgreSQL tests passed, with mocked provider responses only.
- Tests cover all gate/owner checks, wrong/missing pins, revoked/expired/unverified sessions,
  request spoofing, origin protection, concurrency, pending/active duplicates and cancellation boundaries.
- Targeted ESLint and production build passed with synthetic Google IDs and no provider credentials.
- Existing payment/webhook/paid-period/rendering modules and seven presets were preserved.

Separate deployment approval is required to pin this review commit on production WEB ONLY and set
the single verified founder digest, preserving public checkout=false and all existing Live pins.
The existing idempotent pre-deploy command needs its usual explicit approval; no new migration exists.
The worker needs no redeployment for this server-only authorization helper.

After deployment verification, request separate authorization for exactly one founder checkout.
The founder then completes the $5/month recurring purchase manually. No payment is authorized by
this implementation task. Verify the genuine signed payment/activation, exact owner correlation,
confirmed initial paid period and 15-slot entitlement; do not grant from Processing state.
Use the same subscription for later separately approved cancellation/expiry acceptance. Do not
force renewal or alter billing dates, and do not expand the paid beta without reviewing those risks.

# Confirmed paid-period safety

Base: 8ba190733826b1c286851155139bba7d3b994919. No editor/worker implementation,
checkout design, prices, dependency versions or provider settings are changed.

## Grant rules

The signed subscription lifecycle remains an observed provider snapshot. It is
not a paid entitlement. Each grant is an immutable `dodo_paid_periods` row tied
to an authenticated owner and two signature-verified receipt IDs:

- Initial purchase: existing checkout-session/payment/subscription ownership
  correlation plus signed activation of the creation period. Customer, product,
  mode, business and brand must agree. No email-based ownership inference.
- Renewal: signed `subscription.renewed` with explicit `payment_id`, exact period
  and identities, joined to signed `payment.succeeded` for that same payment,
  customer and subscription. Recurring payments may omit `checkout_session_id`;
  they cannot establish initial ownership. No timestamp-based period inference.

Dodo documents renewal `payment_id` here:
https://docs.dodopayments.com/developer-resources/webhooks/intents/subscription
If that field or the matching successful payment evidence is absent, no allowance
is granted. Processing/failed/missing payments never extend a paid period.

Receipts store only normalized billing evidence, without customer email, checkout
reference or raw payload. Successful receipts arriving in either order, including
late evidence older than the observed lifecycle cursor, reconcile transactionally.
The subscription advisory lock serializes delivery. Unique payment IDs and period
keys prevent reuse, overwrite and duplicate quota grants; conflicting evidence
fails closed. Account status/usage, cancellation eligibility, reservation and
worker claiming read confirmed paid periods with current mode/identity pins.
An existing paid window survives past-due renewal snapshots; no unpaid grace is
introduced. Terminal cancellation/expiry still denies access.

## Migration and deployment requirements (not performed)

Run existing `npm run migrate:jobs` on the approved isolated database before the
new web and worker code. It adds a nullable receipt `billing_evidence` JSONB column,
its lookup index, the immutable paid-period table, and the paid-subscription view.
The migration is rerunnable and preserves existing jobs, receipts, identities,
subscriptions, correlations and quota history. It does NOT infer historical paid
periods from mutable subscription dates or automatically reset quota.

Existing accounts without paid-period rows fail closed after the new gate is
deployed. Before production enforcement, separately review a backfill using
genuine signed initial/renewal and successful-payment payloads. A genuine signed
duplicate receipt can fill previously missing evidence only if its payload hash
matches the existing receipt. No replay, backfill or provider call is authorized
or executed by this patch. Keep original subscriber and quota period keys intact.
Legacy tests that seed only mutable subscription rows no longer constitute proof
of paid access; the focused new suite supplies signed financial evidence instead.

Deploy web and worker with the same reviewed revision and identity settings.
Rolling back to the older billing gate reintroduces the known vulnerability;
leave additive tables/history intact. Publication does not authorize deployment.

## Focused checks

Use disposable database `cliponaut_paid_period` and
`CLIPONAUT_ISOLATED_BILLING_TESTS=true`. The new regression file signs synthetic
webhooks locally and blocks external requests. It covers initial ordering,
renewal ordering, Processing/failure, expiry, delayed and duplicate evidence,
conflicting/missing identity/period links, account and mode isolation, concurrent
15-slot reservations, worker claim, cancellation boundaries and safe migration.
No genuine provider acceptance, payment or render is claimed by these fixtures.

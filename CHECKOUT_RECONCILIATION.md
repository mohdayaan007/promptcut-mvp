# Checkout retry safety and bounded recovery

## Release behavior

A fresh authenticated customer with no active/past-due subscription and no
unresolved correlation receives the exact validated Dodo creation-response URL,
including any query parameters. The existing identity lock serializes purchases.

Any `pending`, `created` or `payment_verified` correlation blocks another attempt
with HTTP 409, `checkout_reconciliation_required`, no checkout URL, and a link to
the existing support contact. Local seven-day correlation expiry is never proof
of provider-link validity or permission to create another charge. There is no
automatic provider retry, replacement, session reconstruction or expiry cleanup.

## One-account support review

1. Resolve the affected subscriber through a valid authenticated server session.
   Match the exact existing checkout reference/session and reported attempt time.
   Never identify the customer by email or newest-row selection alone.
2. Read only that checkout's provider status, correlated signed receipts,
   subscription and confirmed paid-period evidence. Preserve all rows and IDs.
3. If payment succeeded, do not replace: reconcile the existing signed payment
   and checkout ownership through the accepted webhook mechanism. If processing,
   pending, absent, conflicting, unavailable or otherwise uncertain, retain the
   blocking reservation and tell the customer support review is required.
4. A provider GET with HTTP 200/null payment, a 404, elapsed time, local expiry or
   an unavailable-link screenshot is insufficient to release the reservation.
   The documented session-status GET does not expose link expiry or the original
   creation URL. Obtain authoritative evidence that the exact earlier session is
   terminal, unpaid AND cannot later accept/complete a charge. If that cannot be
   established, stop; no replacement. Provider assistance may be necessary.
5. Only with that evidence and separate founder approval may an operator close
   exactly one correlation as `failed`. Use a transaction and compare-and-set
   guards for the verified subscriber, reference hash, session ID, expected
   status, unverified payment provenance, absent payment/subscription identifiers,
   and no matching signed payment, subscription ownership or paid-period grant.
   Lock/recheck the subscriber and correlation. Exactly one changed row or roll
   back. Preserve every identifier for audit; never delete or alter history.
   Conflicting evidence or existing payment identifiers require a separately
   reviewed reconciliation, not this path. No production correction is included
   or authorized by this code release.
6. After independent verification of that separately approved correction, the
   customer may explicitly start one fresh checkout. The support operation and
   this route never initiate it automatically.

## Deployment approval plan

- Publish the reviewed isolated patch only after approval; record its immutable
  SHA and parent `30ab555e6527e6af005c7a5c1de6016097aba34b`.
- Stage that exact SHA on production web only; verify pending scope contains only
  source selection. No new variables, migration, worker or billing-data changes.
- Obtain separate approval before deploying. Preserve founder allowlist,
  customer quota/enforcement, Live pins, secrets and current checkout flag.
- The existing idempotent migration hook may run only if separately approved;
  this patch adds no schema changes.
- Verify exact web SHA, health and support presentation. Do not create a checkout
  during those checks.
- With separate approval, one controlled fresh account with no unresolved
  purchase may request one checkout. Verify exact provider URL fidelity and page
  usability; do not authorize payment as part of that check. Do not reload or
  reopen an unusable hosted page automatically: provider single-page behavior can
  initialize payment state on page load.
- The currently affected account remains blocked until its previous session can
  be reconciled under the evidence requirements above. Successful renewal/expiry
  acceptance remains outside this repair.

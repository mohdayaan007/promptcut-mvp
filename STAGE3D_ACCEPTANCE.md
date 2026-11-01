# Stage 3D: scoped release and acceptance

Base: accepted commercial commit `7eb78e295900d1cc14608f978abfda3cb6097491`.
Stage 3C signed activation/receipt/identity acceptance remains complete. Do not
repeat it, attach its unbound subscription by email, or alter its database rows.
The production editor must retain its current reviewed behavior; this snapshot
is a billing patch source, not authorization to replace newer production code.

## Code scope

- Google public client ID is provided at Docker build time. Server ID-token
  validation, nonce handling and secure sessions are retained.
- Customer checkout needs a Google session, same-origin POST, explicit checkout
  enable flag and all three identity pins. Founder access is no longer required.
- A subscriber row lock serializes checkout creation. Active/past-due subscriptions
  prevent another purchase. Same-mode created sessions can be resumed without a
  second provider POST. Mode tags precede the existing reference HMAC in its TEXT
  column; no schema change or raw reference storage is introduced. Legacy records
  still bind through their provider session; they cannot be resumed without mode
  proof. Expired, uncertain, payment-verified or conflicting checkouts are held for
  manual review rather than creating another subscription. Definite provider
  rejection releases the gate. Advanced automatic recovery is not implemented.
- API hosts, product pins and webhook secrets come only from the selected mode.
  Live needs an explicit second enable flag, independent Live key/signing secret,
  three identity pins, HTTPS return URL, paid enforcement and allowance 15.
  Test signing secrets never verify Live events. The legacy founder checkout is
  Test-only. Cancellation recovery remains Test-only and is off by default.
- Existing signed payment/session/subscription ownership, atomic quota ledger,
  scheduled cancellation and renewal/expiry semantics are retained.

## Staging configuration to approve later

Reuse project `cliponaut-dodo-stage1-staging`, its web service, isolated Postgres
and accepted endpoint. Deploy the separately reviewed Stage 3D revision only after
approval. Nothing in this file authorizes configuration, deployment or payments.

Public configuration:

```
DODO_ENVIRONMENT=test
DODO_TEST_MODE_ENABLED=true
DODO_TEST_CUSTOMER_CHECKOUT_ENABLED=true
DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED=true
DODO_TEST_CANCELLATION_RECOVERY_ENABLED=false
DODO_TEST_CLIPONAUT_PRODUCT_ID=pdt_0NqfvnCmCW8YiifWlVCLT
DODO_TEST_BRAND_ID=brnd_0NqfsdlaHQ5sYFSeq7gy3
DODO_TEST_BUSINESS_ID=bus_0NdkBSex5ZRNxaB4G66cb
DODO_TEST_RETURN_URL=https://cliponaut-dodo-test-web-staging.up.railway.app/account
FOUNDER_CONVERSATIONAL_EDITING_ENABLED=false
PAID_EDITING_ENFORCEMENT_ENABLED=true
PAID_RENDER_ALLOWANCE=15
JOB_WORKER_CONCURRENCY=1
```

Preserve staging's own `DATABASE_URL` reference, port and sealed authentication
and Dodo secrets. No secret values belong in tools, approvals or this document.

Set `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` at build and the matching
`GOOGLE_OAUTH_CLIENT_ID` at runtime. Configure Google authorized JavaScript origins
for the staging hostname and canonical production hostname. Existing token-based
Google sign-in does not require an OAuth client secret. Confirm the Google consent
audience is suitable for intended customers rather than only founder test users.

One deterministic render needs the existing image's FFmpeg/ffprobe, the same
staging DB and private storage configuration: `STORAGE_BUCKET`, `STORAGE_ENDPOINT`,
`STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` and the
provider-appropriate `STORAGE_FORCE_PATH_STYLE`. Storage credentials must be
entered directly and restricted to staging-owned storage; production credentials
or customer media are not test inputs. Allow staging's origin in upload CORS and
preserve private objects and signed results. No staging storage is currently
configured. Reuse an existing isolated storage location if available; creating
one requires explicit approval.

After approval, run the existing worker temporarily in the staging container,
concurrency 1, for one short deterministic trim; stop it gracefully after job
completion. This avoids a new permanent worker service. Existing Railway CPU and
storage usage may accrue metered costs; no render or paid AI call is authorized
by this preparation document. A permanent production rollout reuses the existing
worker/storage with matching reviewed billing configuration.

## Minimum acceptance, in order

1. Founder-approved Google configuration/build and Stage 3D staging deployment.
   Verify sign-in/logout and that anonymous/cross-origin checkout cannot create
   provider sessions. No repeated Stage 3A-C setup or payment-ingestion preflight.
2. Separately approve one authenticated Test checkout for the unchanged $6/month
   product. Prove customer session -> stored checkout correlation -> signed
   payment/subscription -> the same subscriber, and deny another account's access.
   A repeated checkout click must reuse the session or fail safely. The earlier
   hosted checkout is not authenticated ownership evidence.
3. Approve the storage setup and one short deterministic render. Verify its
   reservation becomes consumed exactly once and the result is private. Do not
   render 15 files to prove the limit: use the focused disposable-Postgres test
   for 15 consumed slots, request 16 rejection, fresh period and expiry.
4. Separately approve Test-only lifecycle mutations on that owned test subscription:
   documented future `next_billing_date` advance for one actual renewal, followed
   by customer account cancellation at a verified future period end. Verify genuine
   signed provider scheduling/terminal events, new quota period, access retained
   until the paid boundary, and denial afterward. Do not fabricate signed provider
   evidence, immediately cancel as a substitute, or change production timestamps.
   Existing fixture tests are simulated evidence, not this genuine acceptance.

## Live gate (not activated)

Keep staging in Test Mode. Production will require `DODO_ENVIRONMENT=live`,
`DODO_LIVE_MODE_ENABLED=true`, `DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED=true`, and
`DODO_LIVE_SUBSCRIPTION_CANCELLATION_ENABLED=true`, together with independent
`DODO_LIVE_API_KEY`, `DODO_LIVE_WEBHOOK_SECRET`, `DODO_LIVE_CLIPONAUT_PRODUCT_ID`,
`DODO_LIVE_BUSINESS_ID`, `DODO_LIVE_BRAND_ID` and `DODO_LIVE_RETURN_URL`. No fallback
to Test credentials/config is permitted. Web and worker must use the same Live
product and paid-enforcement/15-slot settings. Do not carry Test billing fixtures
or pending sessions into the production database.

Confirm Cliponaut-specific Live brand `enabled=true`, `verification_status=Success`
and expected business identity, plus the unchanged $6/month recurring Live product.
Shared merchant approval alone is insufficient. Confirm current refund policy
wording with the founder; refund automation is outside scope.
Live webhook setup must use its own secret and only handled events:
`payment.succeeded`, `subscription.active`, `subscription.renewed`,
`subscription.updated`, `subscription.cancelled`, `subscription.expired`,
`subscription.past_due`, `subscription.on_hold`, `subscription.failed`.
All publication, deployment, provider configuration and Live activation require
separate approval. No other product or endpoint is part of this release.

## Isolated checks

Use only a disposable database; accepted integration fixtures delete synthetic
rows. Never run them against staging's genuine webhook evidence or production.
Set `CLIPONAUT_ISOLATED_BILLING_TESTS=true` plus its isolated `DATABASE_URL` to run
the new integration cases. `npm run test:paid-launch` runs new mode, checkout and
quota checks. Provider fetches must be injected/mocked. No actual renderer or
provider lifecycle action is necessary for those checks.

# Production billing integration and controlled Live cutover

## Source and scope

- Production web runtime and Railway deployment: `27747f8674dfe391acb6b2a0e088965fe6d32121`.
- Production worker runtime: `0c29e976de929d991873deda53073c6ff08c72f7`, concurrency 1.
- Billing foundation: `99550be4e043ffca36e9989c4641fd208180b8cd`.
- Review commit has the exact production web commit as its sole parent.
- Integrated authenticated Google account, checkout ownership correlation, signed webhook processing,
  confirmed paid periods, render reservations/account usage and period-end cancellation.
- Kept deployed production public-page design, content-safety page/navigation, private storage,
  media configuration, FFmpeg executor/validator, and all seven versioned preset profiles.
- Retained accepted billing-side conversation confirmation and media-preflight protections.
- Launch copy: $5 USD/month, automatically recurring until cancellation, no free trial,
  15 successful renders per verified paid billing period. Test product is unchanged.
- Additional guard rejects reused Test product/brand pins in Live configuration.
- No deployment, production migration, credentials, provider mutations, or real AI/media calls.

## Paid-period safety

Signed subscription.updated/active status alone cannot grant a new paid period.
An initial period requires signed successful payment plus matching signed activation creation
period and the original server-owned checkout correlation. Renewal requires signed
subscription.renewed with payment_id and exact period, plus matching signed payment.succeeded.
Product/customer/subscription/business/brand/mode and authenticated ownership must agree.
Recurring payments may omit checkout_session_id; initial ownership may not.
Pending, failed, missing or conflicting evidence grants nothing. Late evidence reconciles
independently of lifecycle ordering; duplicate payment/period keys cannot extend allowance.
Account usage, render reservations/worker claims and cancellation eligibility read confirmed periods.

## Validation performed on this integration

- 15/15 signed mock payment/paid-period PostgreSQL regressions, including Live pins and foreign products.
- 25/25 focused authentication, origin, mode, account/editor presentation and production integration checks.
- 1/1 focused seven-style recipe compiler regression; no media render or AI request.
- 1/1 exact production-schema migration compatibility check, including repeated migration and preserved history.
- Targeted ESLint on changed JavaScript files and production Next.js build passed.
- Build used synthetic Google client IDs and no provider credentials.
- Production media executor/validator, style catalog, storage and media configuration were checked byte-for-byte.
- No real provider lifecycle acceptance is claimed by these mocked checks.

## Existing production resources (no new infrastructure)

Railway project `mellow-mindfulness` (`2c72e25f-380d-4d3b-9933-c80721bcd59a`),
environment `production` (`a355dbf7-a521-4057-a5a9-bf8587c3b8f2`):

- Web `promptcut-mvp`: `02916644-e59d-4cde-a519-14f571206894`.
- Worker `cliponaut-worker`: `173cbcc2-b3f3-4190-b8d5-b12678440622`.
- PostgreSQL `584a0c18-2b69-4041-ab68-6f32e2327a2c` and existing private bucket `sorted-wardrobe`.
- Existing web pre-deploy command: `npm run migrate:jobs`.
- Existing worker start: `npm run worker`; keep concurrency 1 and existing scratch volume.
- Worker saved source selector differs from running SHA: explicitly pin both services to the
  reviewed integration SHA during the separately approved cutover, not a moving branch.

## Exact configuration checklist — prepare only; approval required to apply

Web non-secret configuration:

```text
PORT=8080
CUSTOMER_CHECKOUT_ORIGIN=https://cliponaut.com
GOOGLE_OAUTH_CLIENT_ID=<existing authorized Cliponaut Web client ID>
NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=<same ID, available during build and runtime>
DODO_ENVIRONMENT=live
DODO_LIVE_MODE_ENABLED=true
DODO_LIVE_CLIPONAUT_PRODUCT_ID=pdt_0Nr1dKa0axNc4wD0dg8c4
DODO_LIVE_BRAND_ID=brnd_0NqfnWquQ3BudsIBEK782
DODO_LIVE_BUSINESS_ID=bus_0NdkBSex5ZRNxaB4G66cb
DODO_LIVE_RETURN_URL=https://cliponaut.com/account
DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED=false
DODO_LIVE_SUBSCRIPTION_CANCELLATION_ENABLED=true
DODO_TEST_MODE_ENABLED=false
DODO_TEST_CUSTOMER_CHECKOUT_ENABLED=false
DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED=false
DODO_TEST_CANCELLATION_RECOVERY_ENABLED=false
FOUNDER_CONVERSATIONAL_EDITING_ENABLED=false
PAID_EDITING_ENFORCEMENT_ENABLED=true
PAID_RENDER_ALLOWANCE=15
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The Live mode/enforcement settings above are a future approved cutover, not changes made
by this review. Keep Live customer checkout disabled until receiver/configuration checks pass
and the founder separately authorizes the first controlled real checkout.

Founder-only secrets, entered and sealed directly in the production web service's Variables:

- Independent `CUSTOMER_AUTH_TOKEN_SECRET` (at least 32 characters; prefer 64 random characters).
- `DODO_LIVE_API_KEY`, Live-only key with checkout permission, subscription read/write for
  customer cancellation, and required read permissions. Never reuse the Test key.
- `DODO_LIVE_WEBHOOK_SECRET`, from one dedicated Cliponaut Live endpoint; never reuse/rotate
  a Test/BYND endpoint secret. Verify existence/sealed status by name only.

Do not copy staging Google sessions, Test subscriptions, financial receipts or paid periods.
Live grants must originate from Live signed evidence and Live checkout correlation.

Worker needs the same selected mode, enable flag, Live product/brand/business pins,
`PAID_EDITING_ENFORCEMENT_ENABLED=true`, `PAID_RENDER_ALLOWANCE=15`, and the same production
PostgreSQL database. Preserve its existing storage/Gemini configuration, retention limits,
scratch volume and `JOB_WORKER_CONCURRENCY=1`. The worker does not need Google/session secrets
or Dodo API/signing credentials for quota claims; cancellation recovery stays disabled.

Preserve existing private STORAGE_ENDPOINT/BUCKET/REGION/FORCE_PATH_STYLE and credential
references on both services. Do not expose credentials or signed URLs. Verify the private
bucket CORS allows exactly the production browser origin and required upload methods;
retain FFmpeg/ffprobe support. No bucket/worker provisioning is needed.

Google Console: authorize `https://cliponaut.com` on the existing Web client; the ID-token
flow uses a nonce and no OAuth redirect callback/client secret. Any Console change needs
separate approval. Public build ID must match runtime audience ID exactly.

## Migration and safe rollout — separate founder approval required

1. Review this exact commit and configuration; confirm Live product in dashboard is $5 USD
   monthly recurring, quantity 1, no trial/coupons/managed credits, under the pinned brand/business.
2. Approve a controlled cutover window. Let existing queued/running edits finish before enabling
   paid enforcement: historical anonymous jobs lack account/quota ownership and must not be
   automatically reassigned by email or inferred as paid. Preserve historical jobs/objects.
3. Take a production database backup/recovery point. Run the existing additive migration via
   web pre-deploy once, before deploying the matching worker. It creates billing/auth/quota
   tables, nullable ownership columns and the paid-period view/indexes; no destructive reset
   or automatic historical backfill. See PAID_PERIOD_SAFETY.md. No production migration ran here.
4. Deploy this exact SHA to existing web and worker with matching mode/pins/database; verify
   runtime SHA, web health, schema, Google nonce/sign-in, anonymous/foreign-origin rejection
   and worker readiness before opening checkout. Keep public checkout off during validation.
5. Separately approve creating a dedicated Cliponaut Live webhook at
   `https://cliponaut.com/api/webhooks/dodo`, using only payment.succeeded,
   subscription.active, subscription.renewed, subscription.updated, subscription.cancelled,
   subscription.expired, subscription.past_due, subscription.on_hold and subscription.failed.
   Shared-business subscribed endpoints may also receive events; leave every existing endpoint
   untouched. This implementation rejects foreign product/brand/business and Test signatures.
6. Founder finalizes public refund/legal terms before taking money. Current public policies
   still describe checkout as closed and refund terms as pending; no new refund promise is added.
7. Successful renewal and customer cancellation/expiry remain provider-acceptance gaps.
   Mocked regressions prove safety, not successful genuine provider behavior. Complete bounded
   Test Mode lifecycle acceptance before opening general paid access, or explicitly review
   the residual risk for a controlled founder-only Live checkout.
8. First real payment requires separate approval: enable Live customer checkout only then and
   verify signed receipt + checkout correlation + paid period + 15-slot ownership evidence.

No rollback may rewrite financial evidence. Record both pre-cutover deployment IDs and retain
the additive schema; an application rollback and enforcement changes require founder approval.

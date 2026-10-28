# Dodo Test Mode — Stage 1

This branch adds a founder-only, server-owned **test-mode** checkout endpoint and a raw-body webhook receiver. It does not make checkout public, grant editor access, enforce a render allowance, or authorize 4K/1080p rules.

## Required server-only configuration

- `DODO_TEST_MODE_ENABLED=true` — keep unset outside the isolated test environment.
- `DODO_TEST_API_KEY` — Cliponaut's dedicated test key; never expose it to the browser.
- `DODO_TEST_CLIPONAUT_PRODUCT_ID` — only the Cliponaut Pro test subscription product ID.
- `DODO_TEST_RETURN_URL` — exact HTTPS return location (local HTTP is allowed only for local testing).
- `DODO_TEST_WEBHOOK_SECRET` — Dodo webhook signing secret (`whsec_…`).
- Existing `FOUNDER_CONVERSATIONAL_EDITING_ENABLED=true` and `FOUNDER_TEST_ACCESS_SECRET` — required to call the checkout endpoint.

In Dodo Test Mode, create a webhook pointing to `/api/webhooks/dodo`, subscribe it to subscription activation, renewal, failure/on-hold, cancellation and expiry events, plus payment success/failure for operational visibility. Do not attach this endpoint to BYND configuration. The receiver verifies Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) against the untouched request body and rejects stale/forged requests.

## Checkout behavior

`POST /api/billing/dodo/checkout` requires the existing signed founder cookie and sends only the configured product in `product_cart`, quantity one, `minimal_address: true`, and `feature_flags.single_page: true`. It uses Dodo's documented `POST /checkouts` test endpoint. The API key and product ID never cross the browser boundary. A return URL is supplied; no unverified cancellation parameter is sent.

## Identity and access boundary

The database now has payment-event/subscription records plus `subscriber_identities`. A Dodo customer email is recorded as unverified evidence only. It cannot activate editing. Before any access enforcement, add an email-delivery provider and a one-time, expiring, hashed verification-token flow; then link a verified identity to an active Cliponaut subscription in one database transaction. Founder cookies and job/session tokens are deliberately not customer identities.

The later entitlement layer must count only successfully completed renders server-side and define billing-period/reset, retry, cancellation and refund semantics before the proposed 15-render rule is activated.

## Authorizing an end-to-end test

Before authorizing a real Test Mode checkout: configure the five variables above in an isolated environment, set the exact test webhook URL/secret/events in Dodo, confirm the configured product belongs to Cliponaut (not BYND), and provision the verified-email delivery flow. Run `npm run test:dodo`, lint, and build first. No live key, live product, Railway deployment, or real payment is included in this stage.

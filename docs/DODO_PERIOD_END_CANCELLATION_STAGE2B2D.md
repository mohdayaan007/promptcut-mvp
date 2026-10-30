# Period-end cancellation — Stage 2B-2D

This Test Mode-only capability is disabled unless `DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED=true`.

## Verified SDK contract

The official `dodopayments` TypeScript SDK v2.59.0 defines `subscriptions.update(id, body)` as `PATCH /subscriptions/{id}`. Its `SubscriptionUpdateParams` documents `status: "cancelled"` plus `cancel_at_next_billing_date: true` as a period-end cancellation. The returned `Subscription` exposes `cancel_at_next_billing_date`, `previous_billing_date`, `next_billing_date`, `product_id`, `brand_id`, and `status`; `subscriptions.retrieve(id)` is `GET /subscriptions/{id}` for future reconciliation. The SDK declares `subscription.updated`, `subscription.cancelled`, `subscription.expired`, and `subscription.renewed` webhooks.

The route sends only `{ cancel_at_next_billing_date: true }`. It accepts a provider response only when it remains `active`, has the configured product and brand, confirms the flag, and has a valid period matching the already verified local period. Timeouts are reported as uncertain and do not mutate local entitlement state.

## Access policy

`subscription.updated` with signed, pinned `cancel_at_next_billing_date: true` records `cancellation_scheduled` while retaining `active` status and the existing verified billing period. The existing entitlement query therefore permits reserved and successful renders through that period end. At/after period end, admission fails closed; a signed expiry/cancellation event remains authoritative. Completed outputs retain their existing authorization and storage-retention behavior.

Unpinned/ownership-ineligible webhooks cannot alter cancellation state, status, billing dates, or ordering of a verified subscription. Duplicate and older event IDs/timestamps remain idempotent/stale-safe.

## Required Test Mode configuration

- Existing `DODO_TEST_MODE_ENABLED=true`, `DODO_TEST_API_KEY`, return URL and Cliponaut product ID.
- `DODO_TEST_BUSINESS_ID` and `DODO_TEST_BRAND_ID` pins.
- `DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED=true` only in the isolated authorized Test Mode environment.
- The Dodo key needs **Subscriptions Write** in addition to existing read permissions; no key was changed here.
- Configure signed `subscription.updated`, `subscription.cancelled`, `subscription.expired`, and `subscription.renewed` delivery, then confirm one genuine Test Mode scheduled-cancellation response and webhook shape before enabling the flag.

The official documentation site returned HTTP 403 to this environment, so the endpoint and field contract above was verified against the current official SDK package, not a live API call. No Dodo request was made.

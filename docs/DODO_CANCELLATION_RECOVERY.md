# Dodo Test Mode cancellation recovery

Recovery is disabled unless both `DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED=true` and `DODO_TEST_CANCELLATION_RECOVERY_ENABLED=true` are configured. An uncertain cancellation response creates a case transactionally with the existing durable pending gate. The worker may perform only a bounded, subscription-specific `GET /subscriptions/{id}` reconciliation; it never repeats a cancellation PATCH.

A case closes only when the existing strict subscription parser confirms the same configured Cliponaut product and brand, an active period matching the server-recorded subscription, and `cancel_at_next_billing_date=true`. Negative, unavailable, malformed, mismatched, or unscheduled evidence remains unresolved. Customer access and quota remain governed by the original verified period.

Founder inspection is intentionally read-only: `FOUNDER_CANCELLATION_RECOVERY_OPERATOR=<named operator> node --import tsx scripts/inspect-cancellation-recovery.js <case UUID>`. It derives subscription and customer identifiers from the recovery case; it does not accept provider IDs from the operator. It requires configured Test Mode product/business/brand pins and reports inconclusive evidence without changing state.

Before any future provider-changing recovery action, the founder must obtain written Dodo confirmation of safe replay/idempotency, cancellation cut-off behavior, exact customer/brand isolation, and the acceptable evidence for a negative resolution. That future action needs explicit founder authorization. An unconfigured notification transport remains `unconfigured`; it is never counted as delivered.

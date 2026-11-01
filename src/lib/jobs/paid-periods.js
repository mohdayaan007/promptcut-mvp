import { dodoMode, dodoProductId } from "@/lib/dodo-config";

// Additive only. Historical mutable subscription dates are deliberately NOT backfilled.
export const PAID_PERIODS_SCHEMA = `
ALTER TABLE dodo_webhook_events ADD COLUMN IF NOT EXISTS billing_evidence JSONB;
CREATE INDEX IF NOT EXISTS dodo_billing_evidence_subscription_idx
  ON dodo_webhook_events ((billing_evidence->>'subscriptionId'));
CREATE TABLE IF NOT EXISTS dodo_paid_periods (
  subscription_id TEXT NOT NULL REFERENCES dodo_subscriptions(dodo_subscription_id),
  subscriber_id UUID NOT NULL REFERENCES subscriber_identities(id),
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  product_id TEXT NOT NULL, customer_id TEXT NOT NULL, brand_id TEXT NOT NULL, business_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL CHECK(period_end>period_start),
  payment_id TEXT NOT NULL UNIQUE,
  payment_event_id TEXT NOT NULL REFERENCES dodo_webhook_events(event_id),
  period_event_id TEXT NOT NULL REFERENCES dodo_webhook_events(event_id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id,mode,period_start)
);
CREATE OR REPLACE VIEW dodo_paid_subscriptions AS
 SELECT s.dodo_subscription_id,s.product_id,s.dodo_customer_id,s.customer_email,s.subscriber_id,
   s.ownership_provenance,
   CASE WHEN s.status='past_due' THEN 'active' ELSE s.status END AS status,
   s.cancellation_scheduled,s.cancellation_confirmed_at,s.cancellation_request_started_at,
   s.last_event_at,s.updated_at,p.period_start AS billing_period_start,p.period_end AS billing_period_end,
   p.mode AS paid_mode,p.brand_id AS paid_brand_id,p.business_id AS paid_business_id
 FROM dodo_subscriptions s JOIN LATERAL (
   SELECT p.* FROM dodo_paid_periods p WHERE p.subscription_id=s.dodo_subscription_id
     AND p.subscriber_id=s.subscriber_id AND p.product_id=s.product_id AND p.customer_id=s.dodo_customer_id
     AND p.period_start<=now()
   ORDER BY p.period_start DESC LIMIT 1
 ) p ON true;
`;

// The mode is a validated enum, never a request/header value.
export function paidSubscriptions() {
  const prefix = `DODO_${dodoMode().toUpperCase()}_`;
  const literal = value => `'${String(value || "").replaceAll("'", "''")}'`;
  return `(SELECT * FROM dodo_paid_subscriptions WHERE paid_mode='${dodoMode()}'
    AND paid_brand_id=${literal(process.env[`${prefix}BRAND_ID`])}
    AND paid_business_id=${literal(process.env[`${prefix}BUSINESS_ID`])})`;
}

export function billingEvidence(eventType, subscription, payment, eligible) {
  if (!eligible) return null;
  const item = subscription || payment;
  if (!item) return null;
  const prefix = `DODO_${dodoMode().toUpperCase()}_`;
  if (!item.subscriptionId || !item.customerId || !item.brandId || !item.businessId
    || item.brandId !== process.env[`${prefix}BRAND_ID`]
    || item.businessId !== process.env[`${prefix}BUSINESS_ID`]
    || (subscription && item.productId !== dodoProductId())) return null;
  if (payment && (eventType !== "payment.succeeded" || payment.status !== "succeeded")) return null;
  const evidence = { ...item, type: eventType, mode: dodoMode(), productId: dodoProductId() };
  // No emails, metadata, checkout references or raw payloads in financial evidence.
  delete evidence.email;
  return evidence;
}

/** Reconcile signed evidence in either delivery order, independently of lifecycle ordering. */
export async function confirmPaidPeriods(client, subscriptionId) {
  const owner = (await client.query(`SELECT s.*,c.checkout_session_id,c.provider_payment_id,
    c.subscriber_id AS checkout_owner,c.payment_provenance,c.status AS checkout_status
    FROM dodo_subscriptions s JOIN customer_checkout_correlations c ON c.provider_subscription_id=s.dodo_subscription_id
    WHERE s.dodo_subscription_id=$1 AND s.subscriber_id=c.subscriber_id
      AND s.ownership_provenance='verified' AND c.payment_provenance='verified' AND c.status='bound'`, [subscriptionId])).rows[0];
  if (!owner) return;
  const events = (await client.query(`SELECT event_id,billing_evidence AS evidence FROM dodo_webhook_events
    WHERE billing_evidence->>'subscriptionId'=$1`, [subscriptionId])).rows;
  const matches = e => e && e.mode === dodoMode() && e.productId === owner.product_id
    && e.customerId === owner.dodo_customer_id && e.brandId === process.env[`DODO_${dodoMode().toUpperCase()}_BRAND_ID`]
    && e.businessId === process.env[`DODO_${dodoMode().toUpperCase()}_BUSINESS_ID`];
  const payments = events.filter(r => matches(r.evidence) && r.evidence.type === "payment.succeeded" && r.evidence.status === "succeeded");
  for (const candidate of events) {
    const e = candidate.evidence;
    if (!matches(e) || !["subscription.active", "subscription.renewed"].includes(e.type)
      || e.status !== "active" || !e.billingStart || !e.billingEnd
      || !Number.isFinite(Date.parse(e.billingStart)) || !Number.isFinite(Date.parse(e.billingEnd))
      || Date.parse(e.billingStart) >= Date.parse(e.billingEnd)) continue;
    const initial = e.type === "subscription.active";
    // An activation can establish only the creation period, never a later reactivation.
    if (initial && (!e.createdAt || Date.parse(e.createdAt) !== Date.parse(e.billingStart))) continue;
    const paymentId = initial ? owner.provider_payment_id : e.billingPaymentId;
    if (!paymentId) continue;
    const proof = payments.find(r => r.evidence.paymentId === paymentId
      && (!initial || r.evidence.checkoutSessionId === owner.checkout_session_id));
    if (!proof) continue;
    const samePayment = (await client.query(`SELECT billing_evidence AS evidence FROM dodo_webhook_events
      WHERE billing_evidence->>'paymentId'=$1`, [paymentId])).rows;
    if (samePayment.some(r => !matches(r.evidence) || r.evidence.subscriptionId !== subscriptionId
      || (initial && r.evidence.checkoutSessionId && r.evidence.checkoutSessionId !== owner.checkout_session_id))) continue;
    // Conflicting signed periods for one payment cannot be resolved by arrival order.
    if (events.some(r => matches(r.evidence) && r.evidence.type === "subscription.renewed"
      && r.evidence.billingPaymentId === paymentId
      && (Date.parse(r.evidence.billingStart) !== Date.parse(e.billingStart)
        || Date.parse(r.evidence.billingEnd) !== Date.parse(e.billingEnd)))) continue;
    await client.query(`INSERT INTO dodo_paid_periods(subscription_id,subscriber_id,mode,product_id,customer_id,brand_id,business_id,
      period_start,period_end,payment_id,payment_event_id,period_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
    [subscriptionId,owner.subscriber_id,e.mode,e.productId,e.customerId,e.brandId,e.businessId,
      e.billingStart,e.billingEnd,paymentId,proof.event_id,candidate.event_id]);
  }
}

import crypto from "crypto";
import pg from "pg";
import { dodoMode, dodoProductId, DodoConfigurationError } from "@/lib/dodo-config";

const { Pool } = pg;
let pool;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  return pool;
}

/** Test/process shutdown hook for the module-owned connection pool. */
export async function closeJobStorePool() {
  if (!pool) return;
  const closing = pool; pool = undefined;
  await closing.end();
}

export const EDIT_JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS edit_jobs (
  id UUID PRIMARY KEY,
  access_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('uploading','queued','analyzing','rendering','completed','failed','cancelled')),
  prompt TEXT,
  export_quality TEXT NOT NULL DEFAULT 'standard' CHECK (export_quality IN ('standard','4k')),
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference JSONB,
  output_key TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  source_cleaned_at TIMESTAMPTZ,
  output_cleaned_at TIMESTAMPTZ,
  session_id UUID,
  edit_plan JSONB,
  source_catalog JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edit_jobs_queue_idx ON edit_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS edit_jobs_cleanup_idx ON edit_jobs (status, updated_at);
CREATE TABLE IF NOT EXISTS editing_sessions (
  id UUID PRIMARY KEY,
  access_token TEXT NOT NULL UNIQUE,
  source_job_id UUID NOT NULL REFERENCES edit_jobs(id),
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE TABLE IF NOT EXISTS editing_versions (
  session_id UUID NOT NULL REFERENCES editing_sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  job_id UUID NOT NULL REFERENCES edit_jobs(id),
  prompt TEXT NOT NULL,
  plan JSONB,
  confirmation TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, version)
);
CREATE INDEX IF NOT EXISTS editing_sessions_expiry_idx ON editing_sessions (expires_at);
CREATE TABLE IF NOT EXISTS subscriber_identities (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_subject TEXT UNIQUE,
  google_email_authority TEXT NOT NULL DEFAULT 'unknown' CHECK (google_email_authority IN ('unknown','gmail','workspace','external')),
  google_hosted_domain TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dodo_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dodo_subscriptions (
  dodo_subscription_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  dodo_customer_id TEXT,
  customer_email TEXT,
  subscriber_id UUID REFERENCES subscriber_identities(id),
  ownership_provenance TEXT NOT NULL DEFAULT 'unverified' CHECK (ownership_provenance IN ('unverified','verified','conflicting')),
  status TEXT NOT NULL CHECK (status IN ('active','past_due','cancelled','expired')),
  cancellation_scheduled BOOLEAN NOT NULL DEFAULT false,
  cancellation_confirmed_at TIMESTAMPTZ,
  cancellation_request_started_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dodo_subscriptions_subscriber_idx ON dodo_subscriptions (subscriber_id, status);
ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS billing_period_start TIMESTAMPTZ;
ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS billing_period_end TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS render_quota_reservations (
  id UUID PRIMARY KEY, subscriber_id UUID NOT NULL REFERENCES subscriber_identities(id), subscription_id TEXT NOT NULL REFERENCES dodo_subscriptions(dodo_subscription_id),
  period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL, job_id UUID UNIQUE REFERENCES edit_jobs(id),
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS render_quota_reservations_period_idx ON render_quota_reservations (subscriber_id, subscription_id, period_start, state);
CREATE TABLE IF NOT EXISTS customer_verification_tokens (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS customer_verification_email_idx ON customer_verification_tokens (email, created_at DESC);
CREATE TABLE IF NOT EXISTS customer_sessions (
  id UUID PRIMARY KEY,
  subscriber_id UUID NOT NULL REFERENCES subscriber_identities(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS customer_sessions_token_idx ON customer_sessions (token_hash, expires_at);
CREATE TABLE IF NOT EXISTS google_login_nonces (
  token_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS customer_checkout_correlations (
  reference_hash TEXT PRIMARY KEY,
  subscriber_id UUID NOT NULL REFERENCES subscriber_identities(id) ON DELETE CASCADE,
  checkout_session_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  payment_provenance TEXT NOT NULL DEFAULT 'unverified' CHECK (payment_provenance IN ('unverified','verified','conflicting')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','payment_verified','bound','failed','conflicted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_checkout_correlations_subscriber_idx ON customer_checkout_correlations (subscriber_id, status, expires_at);
CREATE TABLE IF NOT EXISTS cancellation_recovery_cases (
  id UUID PRIMARY KEY,
  subscriber_id UUID NOT NULL REFERENCES subscriber_identities(id),
  subscription_id TEXT NOT NULL REFERENCES dodo_subscriptions(dodo_subscription_id),
  dodo_customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL, business_id TEXT NOT NULL, brand_id TEXT NOT NULL,
  billing_period_start TIMESTAMPTZ NOT NULL, billing_period_end TIMESTAMPTZ NOT NULL,
  cancellation_requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  state TEXT NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved','confirmed','escalation_required')),
  next_reconciliation_at TIMESTAMPTZ NOT NULL DEFAULT now(), review_deadline_at TIMESTAMPTZ NOT NULL,
  lease_token UUID, lease_until TIMESTAMPTZ, last_verified_at TIMESTAMPTZ,
  notification_state TEXT NOT NULL DEFAULT 'unconfigured' CHECK (notification_state IN ('unconfigured','pending','sent','failed')),
  resolution_evidence JSONB, audit JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, billing_period_start)
);
CREATE INDEX IF NOT EXISTS cancellation_recovery_due_idx ON cancellation_recovery_cases (state, next_reconciliation_at, lease_until);
`;

function newId() { return crypto.randomUUID(); }
function newToken() { return crypto.randomBytes(32).toString("base64url"); }
function safeRow(row) {
  return {
    id: row.id, status: row.status, prompt: row.prompt, exportQuality: row.export_quality,
    sources: row.sources, reference: row.reference, outputKey: row.output_key, errorMessage: row.error_message,
    attemptCount: row.attempt_count, workerId: row.worker_id, claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at, sourceCleanedAt: row.source_cleaned_at,
    outputCleanedAt: row.output_cleaned_at, sessionId: row.session_id, editPlan: row.edit_plan, sourceCatalog: row.source_catalog,
    subscriberId: row.subscriber_id, quotaReservationId: row.quota_reservation_id,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export async function migrateEditJobs() {
  await database().query(EDIT_JOBS_SCHEMA);
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS reference JSONB;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS session_id UUID;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS edit_plan JSONB;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS source_catalog JSONB;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS subscriber_id UUID REFERENCES subscriber_identities(id);");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS quota_reservation_id UUID;");
  await database().query("ALTER TABLE editing_sessions ADD COLUMN IF NOT EXISTS subscriber_id UUID REFERENCES subscriber_identities(id);");
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ NOT NULL DEFAULT now();");
  await database().query("ALTER TABLE subscriber_identities ADD COLUMN IF NOT EXISTS google_subject TEXT UNIQUE;");
  // Existing identities predate Google authority evidence. They must not gain
  // payment ownership until a later, server-verified Google sign-in proves it.
  await database().query("ALTER TABLE subscriber_identities ADD COLUMN IF NOT EXISTS google_email_authority TEXT NOT NULL DEFAULT 'unknown' CHECK (google_email_authority IN ('unknown','gmail','workspace','external'));");
  await database().query("ALTER TABLE subscriber_identities ADD COLUMN IF NOT EXISTS google_hosted_domain TEXT;");
  await database().query("ALTER TABLE customer_checkout_correlations ADD COLUMN IF NOT EXISTS provider_payment_id TEXT UNIQUE;");
  await database().query("ALTER TABLE customer_checkout_correlations ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT UNIQUE;");
  // Historical provider IDs predate provenance validation and must not bind.
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS ownership_provenance TEXT NOT NULL DEFAULT 'unverified' CHECK (ownership_provenance IN ('unverified','verified','conflicting'));");
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS cancellation_scheduled BOOLEAN NOT NULL DEFAULT false;");
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS cancellation_confirmed_at TIMESTAMPTZ;");
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS cancellation_request_started_at TIMESTAMPTZ;");
  await database().query("ALTER TABLE customer_checkout_correlations ADD COLUMN IF NOT EXISTS payment_provenance TEXT NOT NULL DEFAULT 'unverified' CHECK (payment_provenance IN ('unverified','verified','conflicting'));");
  await database().query(`ALTER TABLE edit_jobs DROP CONSTRAINT IF EXISTS edit_jobs_status_check;
    ALTER TABLE edit_jobs ADD CONSTRAINT edit_jobs_status_check
    CHECK (status IN ('uploading','queued','analyzing','rendering','completed','failed','cancelled'));`);
}

export function paidEditingEnforced() {
  const enabled = process.env.PAID_EDITING_ENFORCEMENT_ENABLED === "true";
  if (dodoMode() === "live" && !enabled) throw new DodoConfigurationError("Live paid editing enforcement is required");
  return enabled;
}
function allowance() {
  const value = Number(process.env.PAID_RENDER_ALLOWANCE || 15);
  if (dodoMode() === "live" && value !== 15) throw new DodoConfigurationError("Live render allowance must be 15");
  return Number.isInteger(value) && value > 0 ? value : 15;
}
export async function getEditingEntitlement(subscriberId) {
  if (!subscriberId) return null;
  const { rows } = await database().query(`SELECT * FROM dodo_subscriptions WHERE subscriber_id=$1 AND product_id=$2 AND status='active'
    AND ownership_provenance='verified' AND billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL
    AND billing_period_start <= now() AND billing_period_start < billing_period_end AND billing_period_end > now() ORDER BY billing_period_end DESC LIMIT 1`, [subscriberId, dodoProductId()]);
  return rows[0] || null;
}

/** Only a server-owned, verified, current Cliponaut subscription can be cancelled. */
export async function getCustomerCancellableSubscription(subscriberId) {
  if (!subscriberId) return null;
  const { rows } = await database().query(`SELECT * FROM dodo_subscriptions WHERE subscriber_id=$1 AND product_id=$2
    AND ownership_provenance='verified' AND status='active' AND billing_period_start <= now() AND billing_period_end > now()
    ORDER BY billing_period_end DESC LIMIT 1`, [subscriberId, dodoProductId()]);
  return rows[0] || null;
}

/** A provider-confirmed scheduling response may only annotate the same owned, current period. */
export async function confirmCustomerPeriodEndCancellation(subscriberId, subscriptionId, billingStart, billingEnd) {
  const { rows } = await database().query(`UPDATE dodo_subscriptions SET cancellation_scheduled=true,cancellation_confirmed_at=now(),cancellation_request_started_at=NULL,updated_at=now()
    WHERE dodo_subscription_id=$1 AND subscriber_id=$2 AND product_id=$3 AND ownership_provenance='verified' AND status='active'
      AND date_trunc('milliseconds', billing_period_start)=$4 AND date_trunc('milliseconds', billing_period_end)=$5 AND billing_period_start <= now() AND billing_period_end > now()
    RETURNING *`, [subscriptionId, subscriberId, dodoProductId(), billingStart, billingEnd]);
  return rows[0] || null;
}
export async function beginCustomerPeriodEndCancellation(subscriberId, subscriptionId, provenance = null) {
  const client = await database().connect(); try { await client.query("BEGIN");
    const { rows } = await client.query(`UPDATE dodo_subscriptions SET cancellation_request_started_at=now(),updated_at=now()
      WHERE dodo_subscription_id=$1 AND subscriber_id=$2 AND product_id=$3 AND ownership_provenance='verified' AND status='active'
        AND cancellation_scheduled=false AND cancellation_request_started_at IS NULL AND billing_period_start <= now() AND billing_period_end > now() RETURNING *`, [subscriptionId, subscriberId, dodoProductId()]);
    const subscription = rows[0];
    if (subscription && provenance) {
      if (!subscription.dodo_customer_id || !provenance.businessId || !provenance.brandId) throw new Error("Cancellation recovery provenance is incomplete");
      await client.query(`INSERT INTO cancellation_recovery_cases (id,subscriber_id,subscription_id,dodo_customer_id,product_id,business_id,brand_id,billing_period_start,billing_period_end,review_deadline_at,audit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,LEAST($9::timestamptz,GREATEST(now()+interval '15 minutes',$9::timestamptz-interval '24 hours')),jsonb_build_array(jsonb_build_object('at',now(),'event','request_started')))
        ON CONFLICT (subscription_id,billing_period_start) DO NOTHING`, [newId(),subscriberId,subscription.dodo_subscription_id,subscription.dodo_customer_id,subscription.product_id,provenance.businessId,provenance.brandId,subscription.billing_period_start,subscription.billing_period_end]);
    }
    await client.query("COMMIT"); return subscription || null;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function clearCustomerPeriodEndCancellationRequest(subscriptionId) { await database().query("UPDATE dodo_subscriptions SET cancellation_request_started_at=NULL,updated_at=now() WHERE dodo_subscription_id=$1 AND cancellation_scheduled=false", [subscriptionId]); }
export async function leaseDueCancellationRecoveryCases({ limit = 10, leaseMs = 30_000 } = {}) {
  const token = newId(); const { rows } = await database().query(`WITH due AS (SELECT id FROM cancellation_recovery_cases WHERE state='unresolved' AND next_reconciliation_at <= now() AND (lease_until IS NULL OR lease_until < now()) ORDER BY next_reconciliation_at FOR UPDATE SKIP LOCKED LIMIT $1)
    UPDATE cancellation_recovery_cases c SET lease_token=$2,lease_until=now()+($3::text||' milliseconds')::interval,updated_at=now() FROM due WHERE c.id=due.id RETURNING c.*`, [Math.min(Math.max(Number(limit) || 1,1),25),token,Math.max(Number(leaseMs) || 30_000,1_000)]);
  return rows.map((row) => ({ ...row, leaseToken: token }));
}
export async function recordCancellationRecoveryEvidence(caseId, leaseToken, evidence) {
  const confirmed = evidence?.confirmed === true; const { rows } = await database().query(`UPDATE cancellation_recovery_cases SET state=CASE WHEN $3 THEN 'confirmed' ELSE state END,last_verified_at=now(),next_reconciliation_at=CASE WHEN $3 THEN next_reconciliation_at ELSE now()+interval '30 minutes' END,lease_token=NULL,lease_until=NULL,resolution_evidence=CASE WHEN $3 THEN $4::jsonb ELSE resolution_evidence END,audit=audit||jsonb_build_array(jsonb_build_object('at',now(),'event',CASE WHEN $3 THEN 'provider_confirmed' ELSE 'provider_unresolved' END)),updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND state='unresolved' RETURNING *`, [caseId,leaseToken,confirmed,JSON.stringify(confirmed ? evidence : {})]);
  return rows[0] || null;
}
/** Confirmation is bound to the immutable case, not the latest subscription period or current config alone. */
export async function confirmCancellationRecoveryCase(caseId, leaseToken, evidence, provenance) {
  const client = await database().connect(); try { await client.query("BEGIN");
    const { rows } = await client.query(`SELECT
      c.id AS case_id,c.subscriber_id AS case_subscriber_id,c.subscription_id AS case_subscription_id,c.dodo_customer_id AS case_customer_id,
      c.product_id AS case_product_id,c.business_id AS case_business_id,c.brand_id AS case_brand_id,
      c.billing_period_start AS case_start,c.billing_period_end AS case_end,
      s.subscriber_id AS subscription_subscriber_id,s.dodo_customer_id AS subscription_customer_id,s.product_id AS subscription_product_id,
      s.ownership_provenance AS subscription_ownership_provenance,s.status AS subscription_status,
      s.billing_period_start AS subscription_start,s.billing_period_end AS subscription_end
      FROM cancellation_recovery_cases c JOIN dodo_subscriptions s ON s.dodo_subscription_id=c.subscription_id
      WHERE c.id=$1 AND c.lease_token=$2 AND c.state='unresolved' FOR UPDATE`, [caseId,leaseToken]);
    const recovery = rows[0]; const same = recovery && evidence?.evidenceSource === "signed_webhook" && evidence?.scheduled === true
      && recovery.case_subscription_id === evidence.subscriptionId && recovery.case_customer_id === evidence.customerId
      && recovery.subscription_customer_id === recovery.case_customer_id && recovery.subscription_subscriber_id === recovery.case_subscriber_id
      && recovery.case_product_id === evidence.productId && recovery.subscription_product_id === recovery.case_product_id
      && recovery.case_brand_id === evidence.brandId && recovery.case_business_id === evidence.businessId && recovery.case_business_id === provenance?.businessId
      && recovery.case_brand_id === provenance?.brandId && recovery.case_product_id === provenance?.productId
      && recovery.subscription_ownership_provenance === 'verified' && recovery.subscription_status === 'active'
      && new Date(recovery.case_start).getTime() === new Date(evidence.billingStart).getTime()
      && new Date(recovery.case_end).getTime() === new Date(evidence.billingEnd).getTime()
      && new Date(recovery.subscription_start).getTime() === new Date(recovery.case_start).getTime()
      && new Date(recovery.subscription_end).getTime() === new Date(recovery.case_end).getTime();
    if (!same) { await client.query("ROLLBACK"); return null; }
    const finalized = await client.query("UPDATE dodo_subscriptions SET cancellation_scheduled=true,cancellation_confirmed_at=now(),cancellation_request_started_at=NULL,updated_at=now() WHERE dodo_subscription_id=$1 AND subscriber_id=$2 AND dodo_customer_id=$3 AND product_id=$4 AND ownership_provenance='verified' AND status='active' AND date_trunc('milliseconds', billing_period_start)=$5 AND date_trunc('milliseconds', billing_period_end)=$6 RETURNING dodo_subscription_id", [recovery.case_subscription_id,recovery.case_subscriber_id,recovery.case_customer_id,recovery.case_product_id,recovery.case_start,recovery.case_end]);
    if (!finalized.rowCount) { await client.query("ROLLBACK"); return null; }
    const confirmed = await client.query("UPDATE cancellation_recovery_cases SET state='confirmed',last_verified_at=now(),lease_token=NULL,lease_until=NULL,resolution_evidence=$3::jsonb,audit=audit||jsonb_build_array(jsonb_build_object('at',now(),'event','provider_confirmed')),updated_at=now() WHERE id=$1 AND lease_token=$2 AND dodo_customer_id=$4 AND product_id=$5 AND business_id=$6 AND brand_id=$7 AND date_trunc('milliseconds', billing_period_start)=$8 AND date_trunc('milliseconds', billing_period_end)=$9 RETURNING *", [caseId,leaseToken,JSON.stringify(evidence),recovery.case_customer_id,recovery.case_product_id,recovery.case_business_id,recovery.case_brand_id,recovery.case_start,recovery.case_end]);
    if (!confirmed.rowCount) { await client.query("ROLLBACK"); return null; }
    await client.query("COMMIT"); return confirmed.rows[0] || null;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** A subscription GET has no documented business_id. Only fully pinned, signed evidence may settle recovery. */
async function confirmRecoveryFromSignedSubscription(client, eventId, subscription) {
  if (subscription?.evidenceSource !== "signed_webhook" || subscription.status !== "active" || subscription.cancellationScheduled !== true
    || !subscription.subscriptionId || !subscription.customerId || !subscription.productId || !subscription.brandId || !subscription.businessId
    || !subscription.billingStart || !subscription.billingEnd || !subscription.occurredAt) return false;
  const { rows } = await client.query(`UPDATE cancellation_recovery_cases c SET
      state='confirmed',last_verified_at=now(),lease_token=NULL,lease_until=NULL,
      resolution_evidence=jsonb_build_object('source','signed_webhook','eventId',$1::text,'subscriptionId',$2::text,'customerId',$3::text,'productId',$4::text,'brandId',$5::text,'businessId',$6::text,'billingStart',$7::timestamptz,'billingEnd',$8::timestamptz),
      audit=audit||jsonb_build_array(jsonb_build_object('at',now(),'event','signed_webhook_confirmed')),updated_at=now()
    FROM dodo_subscriptions s
    WHERE c.state='unresolved' AND c.subscription_id=$2 AND c.dodo_customer_id=$3 AND c.product_id=$4 AND c.brand_id=$5 AND c.business_id=$6
      AND date_trunc('milliseconds',c.billing_period_start)=date_trunc('milliseconds',$7::timestamptz)
      AND date_trunc('milliseconds',c.billing_period_end)=date_trunc('milliseconds',$8::timestamptz)
      AND s.dodo_subscription_id=c.subscription_id AND s.subscriber_id=c.subscriber_id AND s.dodo_customer_id=c.dodo_customer_id
      AND s.product_id=c.product_id AND s.ownership_provenance='verified' AND s.status='active'
      AND date_trunc('milliseconds',s.billing_period_start)=date_trunc('milliseconds',c.billing_period_start)
      AND date_trunc('milliseconds',s.billing_period_end)=date_trunc('milliseconds',c.billing_period_end)
      AND date_trunc('milliseconds',s.last_event_at)=date_trunc('milliseconds',$9::timestamptz)
    RETURNING c.id`, [eventId, subscription.subscriptionId, subscription.customerId, subscription.productId, subscription.brandId, subscription.businessId, subscription.billingStart, subscription.billingEnd, subscription.occurredAt]);
  if (!rows.length) return false;
  await client.query(`UPDATE dodo_subscriptions SET cancellation_scheduled=true,cancellation_confirmed_at=COALESCE(cancellation_confirmed_at,now()),cancellation_request_started_at=NULL,updated_at=now()
    WHERE dodo_subscription_id=$1 AND dodo_customer_id=$2 AND product_id=$3 AND ownership_provenance='verified' AND status='active'
      AND date_trunc('milliseconds',billing_period_start)=date_trunc('milliseconds',$4::timestamptz)
      AND date_trunc('milliseconds',billing_period_end)=date_trunc('milliseconds',$5::timestamptz)`, [subscription.subscriptionId, subscription.customerId, subscription.productId, subscription.billingStart, subscription.billingEnd]);
  return true;
}
export async function listUnresolvedCancellationRecoveryCases() {
  const { rows } = await database().query(`SELECT id,subscription_id,billing_period_end,cancellation_requested_at,state,last_verified_at,review_deadline_at,notification_state FROM cancellation_recovery_cases WHERE state='unresolved' ORDER BY review_deadline_at ASC LIMIT 50`);
  return rows;
}
export async function getCancellationRecoveryCaseForOperator(caseId) {
  if (!UUID_PATTERN.test(String(caseId || ""))) return null;
  const { rows } = await database().query(`SELECT c.*,s.ownership_provenance,s.status AS subscription_status FROM cancellation_recovery_cases c JOIN dodo_subscriptions s ON s.dodo_subscription_id=c.subscription_id WHERE c.id=$1`, [caseId]);
  return rows[0] || null;
}
export async function reserveRenderCapacity(subscriberId) {
  const client = await database().connect(); try { await client.query("BEGIN");
    const entitlement = (await client.query(`SELECT s.* FROM dodo_subscriptions s JOIN subscriber_identities i ON i.id=s.subscriber_id WHERE s.subscriber_id=$1 AND s.product_id=$2 AND s.status='active' AND s.ownership_provenance='verified' AND s.billing_period_start IS NOT NULL AND s.billing_period_start <= now() AND s.billing_period_end > now() AND i.verified_at IS NOT NULL AND i.google_subject IS NOT NULL FOR UPDATE`, [subscriberId, dodoProductId()])).rows[0];
    if (!entitlement || !(new Date(entitlement.billing_period_start) < new Date(entitlement.billing_period_end))) { await client.query("ROLLBACK"); return null; }
    const used = (await client.query("SELECT count(*)::int count FROM render_quota_reservations WHERE subscriber_id=$1 AND subscription_id=$2 AND period_start=$3 AND state IN ('reserved','consumed')", [subscriberId, entitlement.dodo_subscription_id, entitlement.billing_period_start])).rows[0].count;
    if (used >= allowance()) { await client.query("ROLLBACK"); return null; }
    const id = newId(); await client.query("INSERT INTO render_quota_reservations (id,subscriber_id,subscription_id,period_start,period_end,state) VALUES ($1,$2,$3,$4,$5,'reserved')", [id, subscriberId, entitlement.dodo_subscription_id, entitlement.billing_period_start, entitlement.billing_period_end]); await client.query("COMMIT"); return id;
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
export async function attachReservationToJob(reservationId, jobId, subscriberId) { if (reservationId) await database().query("UPDATE render_quota_reservations SET job_id=$2,updated_at=now() WHERE id=$1 AND subscriber_id=$3 AND state='reserved'", [reservationId, jobId, subscriberId]); }
export async function releaseUnattachedRenderReservation(reservationId, subscriberId) { if (reservationId && subscriberId) await database().query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE id=$1 AND subscriber_id=$2 AND job_id IS NULL AND state='reserved'", [reservationId, subscriberId]); }
export async function releaseRenderReservation(jobId) { await database().query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE job_id=$1 AND state='reserved'", [jobId]); }

/** Inserts before side effects. The unique event id is the replay/idempotency boundary. */
export async function recordDodoWebhookEvent(eventId, eventType, rawBody) {
  const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const { rowCount } = await database().query(`INSERT INTO dodo_webhook_events (event_id,event_type,payload_sha256)
    VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`, [eventId, eventType, payloadHash]);
  return rowCount === 1;
}

/** Payment state is recorded independently from identity verification; this never grants editor access. */
export async function upsertDodoSubscription({ subscriptionId, productId, customerId, email, status }) {
  await database().query(`INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,customer_email,status)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (dodo_subscription_id) DO UPDATE SET product_id=EXCLUDED.product_id,dodo_customer_id=EXCLUDED.dodo_customer_id,
      customer_email=COALESCE(EXCLUDED.customer_email,dodo_subscriptions.customer_email),status=EXCLUDED.status,updated_at=now()`,
  [subscriptionId, productId, customerId, email, status]);
}

/** Event insertion and state change share one transaction: failed processing stays retryable. */
async function bindProviderVerifiedSubscription(client, subscriptionId) {
  const { rows } = await client.query(`SELECT c.subscriber_id,c.status AS correlation_status,c.payment_provenance,s.subscriber_id AS existing_owner,s.status,s.product_id,s.ownership_provenance
    FROM customer_checkout_correlations c JOIN dodo_subscriptions s ON s.dodo_subscription_id=c.provider_subscription_id
    WHERE c.provider_subscription_id=$1 AND c.provider_payment_id IS NOT NULL FOR UPDATE`, [subscriptionId]);
  const row = rows[0];
  if (!row || row.payment_provenance !== "verified" || row.ownership_provenance !== "verified" || row.status !== "active" || row.product_id !== (dodoProductId())) return false;
  if (row.existing_owner && row.existing_owner !== row.subscriber_id) {
    await client.query("UPDATE customer_checkout_correlations SET status='conflicted',updated_at=now() WHERE provider_subscription_id=$1 AND status <> 'bound'", [subscriptionId]);
    return false;
  }
  await client.query("UPDATE dodo_subscriptions SET subscriber_id=$2,updated_at=now() WHERE dodo_subscription_id=$1 AND subscriber_id IS NULL", [subscriptionId, row.subscriber_id]);
  await client.query("UPDATE customer_checkout_correlations SET status='bound',updated_at=now() WHERE provider_subscription_id=$1", [subscriptionId]);
  return true;
}

export async function processDodoWebhookEvent(eventId, eventType, rawBody, subscription, payment = null, ownershipEligible = false, hooks = {}) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const subscriptionId = subscription?.subscriptionId || payment?.subscriptionId || null;
    // The payment and subscription handlers use the same provider subscription
    // identifier, so one transaction always observes the other's committed row.
    // A single advisory key per event avoids lock-order deadlocks.
    if (ownershipEligible && subscriptionId) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [subscriptionId]);
    const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const inserted = await client.query(`INSERT INTO dodo_webhook_events (event_id,event_type,payload_sha256)
      VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`, [eventId, eventType, hash]);
    if (!inserted.rowCount) {
      if (ownershipEligible && subscriptionId) await bindProviderVerifiedSubscription(client, subscriptionId);
      await client.query("COMMIT"); return false;
    }
    let subscriptionApplied = false;
    if (subscription) {
      const write = await client.query(`INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,customer_email,status,last_event_at,ownership_provenance,billing_period_start,billing_period_end,cancellation_scheduled,cancellation_confirmed_at)
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN 'verified' ELSE 'unverified' END,$8,$9,CASE WHEN $7 THEN $10 ELSE false END,CASE WHEN $7 AND $10 THEN now() ELSE NULL END)
      ON CONFLICT (dodo_subscription_id) DO UPDATE SET product_id=EXCLUDED.product_id,dodo_customer_id=EXCLUDED.dodo_customer_id,
        customer_email=COALESCE(EXCLUDED.customer_email,dodo_subscriptions.customer_email),subscriber_id=COALESCE(dodo_subscriptions.subscriber_id, EXCLUDED.subscriber_id),status=EXCLUDED.status,last_event_at=EXCLUDED.last_event_at,
        ownership_provenance=CASE WHEN $7 THEN 'verified' ELSE dodo_subscriptions.ownership_provenance END,billing_period_start=CASE WHEN $7 THEN COALESCE(EXCLUDED.billing_period_start,dodo_subscriptions.billing_period_start) ELSE dodo_subscriptions.billing_period_start END,billing_period_end=CASE WHEN $7 THEN COALESCE(EXCLUDED.billing_period_end,dodo_subscriptions.billing_period_end) ELSE dodo_subscriptions.billing_period_end END,
        -- API confirmation has no provider occurrence timestamp. A later-delivered
        -- active snapshot without scheduling evidence may predate that confirmation,
        -- so it cannot erase the safer confirmed schedule. Terminal provider states
        -- still update status and revoke entitlement through the normal lifecycle.
        cancellation_scheduled=CASE WHEN $7 AND dodo_subscriptions.cancellation_scheduled=true AND dodo_subscriptions.cancellation_confirmed_at IS NOT NULL AND EXCLUDED.cancellation_scheduled=false AND EXCLUDED.status='active' THEN true WHEN $7 THEN $10 ELSE dodo_subscriptions.cancellation_scheduled END,
        cancellation_confirmed_at=CASE WHEN $7 AND $10 THEN COALESCE(dodo_subscriptions.cancellation_confirmed_at,now()) WHEN $7 AND EXCLUDED.status='active' AND dodo_subscriptions.cancellation_confirmed_at IS NOT NULL THEN dodo_subscriptions.cancellation_confirmed_at WHEN $7 THEN NULL ELSE dodo_subscriptions.cancellation_confirmed_at END,updated_at=now()
      -- Once provider evidence has been verified for this subscription, only
      -- another correctly pinned event may change its lifecycle state or
      -- authoritative ordering cursor.  An unpinned receipt is still retained
      -- in dodo_webhook_events for audit/idempotency, but cannot reactivate a
      -- cancelled subscription or poison ordering for later verified evidence.
      WHERE EXCLUDED.last_event_at > dodo_subscriptions.last_event_at
        AND ($7 OR dodo_subscriptions.ownership_provenance <> 'verified')`,
    [subscription.subscriptionId, subscription.productId, subscription.customerId, subscription.email, subscription.status, subscription.occurredAt, ownershipEligible, subscription.billingStart, subscription.billingEnd, subscription.cancellationScheduled]);
      // Recovery may rely only on this event when the strict lifecycle write
      // itself won. Equality and older events intentionally produce rowCount 0.
      subscriptionApplied = write.rowCount === 1;
    }
    if (payment) await client.query(`UPDATE customer_checkout_correlations
      SET provider_payment_id=$2,provider_subscription_id=$3,payment_provenance=CASE WHEN $4 THEN 'verified' ELSE payment_provenance END,
        status=CASE WHEN $4 THEN 'payment_verified' ELSE status END,updated_at=now()
      WHERE checkout_session_id=$1 AND status IN ('created','payment_verified')
        AND (provider_payment_id IS NULL OR provider_payment_id=$2)
        AND (provider_subscription_id IS NULL OR provider_subscription_id=$3)`, [payment.checkoutSessionId, payment.paymentId, payment.subscriptionId, ownershipEligible]);
    if (payment && ownershipEligible) await client.query(`UPDATE customer_checkout_correlations SET payment_provenance='conflicting',status='conflicted',updated_at=now()
      WHERE checkout_session_id=$1 AND (provider_payment_id IS NOT NULL AND provider_payment_id<>$2 OR provider_subscription_id IS NOT NULL AND provider_subscription_id<>$3)`, [payment.checkoutSessionId, payment.paymentId, payment.subscriptionId]);
    if (subscriptionApplied && ownershipEligible) await confirmRecoveryFromSignedSubscription(client, eventId, subscription);
    await hooks.afterEvidence?.();
    if (ownershipEligible && subscriptionId) await bindProviderVerifiedSubscription(client, subscriptionId);
    await client.query("COMMIT"); return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

function customerTokenHash(token) {
  const secret = process.env.CUSTOMER_AUTH_TOKEN_SECRET || "";
  if (secret.length < 32) throw new Error("CUSTOMER_AUTH_TOKEN_SECRET is not configured");
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}
const CUSTOMER_VERIFICATION_MS = 15 * 60 * 1000;
const CUSTOMER_SESSION_DAYS = 30;

export async function getCustomerSession(token) {
  if (!token) return null;
  const { rows } = await database().query(`SELECT s.subscriber_id,i.email FROM customer_sessions s JOIN subscriber_identities i ON i.id=s.subscriber_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND i.verified_at IS NOT NULL AND i.google_subject IS NOT NULL`, [customerTokenHash(token)]);
  return rows[0] || null;
}

export async function getCustomerSubscriptionStatus(subscriberId) {
  if (!subscriberId) return "not_subscribed";
  const { rows } = await database().query(`SELECT status,cancellation_scheduled,billing_period_end FROM dodo_subscriptions
    WHERE subscriber_id=$1 AND product_id=$2
    ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'past_due' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END, updated_at DESC LIMIT 1`, [subscriberId, dodoProductId()]);
  if (rows[0]?.status) {
    if (rows[0].cancellation_scheduled && rows[0].status === "active") return new Date(rows[0].billing_period_end) <= new Date() ? "expired" : "cancellation_scheduled";
    return rows[0].status;
  }
  const pending = await database().query(`SELECT 1 FROM customer_checkout_correlations
    WHERE subscriber_id=$1 AND status IN ('pending','created','payment_verified') AND expires_at > now() LIMIT 1`, [subscriberId]);
  return pending.rowCount ? "pending_verification" : "not_subscribed";
}

/** Read-only cancellation-management state for the authenticated owner only. */
export async function getCustomerCancellationManagementState(subscriberId) {
  if (!subscriberId) return { state: "none", periodEnd: null };
  const { rows } = await database().query(`SELECT cancellation_scheduled,cancellation_request_started_at,billing_period_end
    FROM dodo_subscriptions WHERE subscriber_id=$1 AND product_id=$2 AND ownership_provenance='verified'
      AND status='active' AND billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL
      AND billing_period_start <= now() AND billing_period_start < billing_period_end AND billing_period_end > now()
    ORDER BY billing_period_end DESC LIMIT 1`, [subscriberId, dodoProductId()]);
  const subscription = rows[0];
  if (!subscription) return { state: "none", periodEnd: null };
  return {
    state: subscription.cancellation_scheduled ? "scheduled" : subscription.cancellation_request_started_at ? "pending" : "none",
    periodEnd: new Date(subscription.billing_period_end).toISOString()
  };
}
export async function getCustomerCancellationRecoveryState(subscriberId) {
  if (!subscriberId) return null;
  const { rows } = await database().query("SELECT id,state,review_deadline_at,last_verified_at FROM cancellation_recovery_cases WHERE subscriber_id=$1 AND state='unresolved' ORDER BY review_deadline_at ASC LIMIT 1", [subscriberId]);
  const row = rows[0]; return row ? { id: row.id, state: row.state, reviewDeadline: new Date(row.review_deadline_at).toISOString(), lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null } : null;
}

/** Read-only account data: all figures come from the server-owned quota ledger. */
export async function getCustomerRenderUsage(subscriberId) {
  const allowanceValue = allowance();
  if (!subscriberId) return { allowance: allowanceValue, billingPeriod: null, successfulRenders: null, reservedRenders: null, remainingRenders: null };
  const { rows } = await database().query(`SELECT dodo_subscription_id,status,ownership_provenance,billing_period_start,billing_period_end
    FROM dodo_subscriptions WHERE subscriber_id=$1 AND product_id=$2 AND ownership_provenance='verified'
    ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'past_due' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END, updated_at DESC LIMIT 1`, [subscriberId, dodoProductId()]);
  const subscription = rows[0];
  const validPeriod = subscription?.ownership_provenance === "verified" && subscription.billing_period_start && subscription.billing_period_end
    && new Date(subscription.billing_period_start) < new Date(subscription.billing_period_end);
  if (!validPeriod) return { allowance: allowanceValue, billingPeriod: null, successfulRenders: null, reservedRenders: null, remainingRenders: null };
  const counts = await database().query(`SELECT count(*) FILTER (WHERE state='consumed')::int AS successful,
    count(*) FILTER (WHERE state='reserved')::int AS reserved
    FROM render_quota_reservations WHERE subscriber_id=$1 AND subscription_id=$2 AND period_start=$3`, [subscriberId, subscription.dodo_subscription_id, subscription.billing_period_start]);
  const successful = counts.rows[0].successful; const reserved = counts.rows[0].reserved;
  const current = subscription.status === "active" && new Date(subscription.billing_period_start) <= new Date() && new Date(subscription.billing_period_end) > new Date();
  return {
    allowance: allowanceValue,
    billingPeriod: { start: new Date(subscription.billing_period_start).toISOString(), end: new Date(subscription.billing_period_end).toISOString() },
    successfulRenders: successful,
    reservedRenders: reserved,
    remainingRenders: current ? Math.max(0, allowanceValue - successful - reserved) : null
  };
}

export async function revokeCustomerSession(token) {
  if (!token) return;
  await database().query("UPDATE customer_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [customerTokenHash(token)]);
}

export async function createGoogleLoginNonce(token) {
  await database().query("INSERT INTO google_login_nonces (token_hash,expires_at) VALUES ($1,now() + interval '10 minutes')", [customerTokenHash(token)]);
}

/** The provider receives the raw value; only a server HMAC is persisted. */
export class CustomerCheckoutConflict extends Error {}

/** Serialize checkout creation per verified customer without a schema change. */
export async function reserveCustomerCheckout(subscriberId) {
  const mode = dodoMode(), productId = dodoProductId();
  if (!productId) throw new DodoConfigurationError("Billing product is not configured");
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query("SELECT id FROM subscriber_identities WHERE id=$1 AND verified_at IS NOT NULL AND google_subject IS NOT NULL FOR UPDATE", [subscriberId]);
    if (!identity.rowCount) throw new CustomerCheckoutConflict("A verified Google account is required.");
    const existing = await client.query("SELECT dodo_subscription_id FROM dodo_subscriptions WHERE subscriber_id=$1 AND product_id=$2 AND status IN ('active','past_due') LIMIT 1", [subscriberId, productId]);
    if (existing.rowCount) throw new CustomerCheckoutConflict("Manage your existing subscription from your account.");
    const pending = (await client.query("SELECT reference_hash,checkout_session_id,status,expires_at FROM customer_checkout_correlations WHERE subscriber_id=$1 AND status IN ('pending','created','payment_verified') ORDER BY created_at DESC LIMIT 1", [subscriberId])).rows[0];
    if (pending) {
      // Only new, mode-tagged records can be safely resumed. Legacy/uncertain
      // outcomes remain blocked for review instead of authorizing another bill.
      if (pending.status === "created" && pending.reference_hash.startsWith(`${mode}:`) && pending.checkout_session_id && new Date(pending.expires_at) > new Date()) {
        await client.query("COMMIT"); return { checkoutId: pending.checkout_session_id };
      }
      throw new CustomerCheckoutConflict("A checkout or payment is already pending. Finish that checkout or contact support before retrying.");
    }
    const reference = newToken();
    await client.query("INSERT INTO customer_checkout_correlations (reference_hash,subscriber_id,expires_at) VALUES ($1,$2,now() + interval '7 days')", [`${mode}:${customerTokenHash(reference)}`, subscriberId]);
    await client.query("COMMIT"); return { reference };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function createCustomerCheckoutCorrelation(subscriberId) {
  if (!subscriberId) throw new Error("Customer identity is required");
  const reference = newToken();
  await database().query(`INSERT INTO customer_checkout_correlations (reference_hash,subscriber_id,expires_at)
    VALUES ($1,$2,now() + interval '7 days')`, [customerTokenHash(reference), subscriberId]);
  return reference;
}

export async function recordCustomerCheckoutSession(subscriberId, reference, checkoutSessionId) {
  const { rowCount } = await database().query(`UPDATE customer_checkout_correlations
    SET checkout_session_id=$3,status='created',updated_at=now()
    WHERE reference_hash IN ($1,$4) AND subscriber_id=$2 AND status='pending' AND expires_at > now()`, [customerTokenHash(reference), subscriberId, checkoutSessionId, `${dodoMode()}:${customerTokenHash(reference)}`]);
  if (!rowCount) throw new Error("Customer checkout correlation could not be recorded");
}

export async function failCustomerCheckoutCorrelation(subscriberId, reference) {
  await database().query(`UPDATE customer_checkout_correlations SET status='failed',updated_at=now()
    WHERE reference_hash IN ($1,$3) AND subscriber_id=$2 AND status='pending'`, [customerTokenHash(reference), subscriberId, `${dodoMode()}:${customerTokenHash(reference)}`]);
}

/** Atomically consumes a Google-bound nonce, resolves stable-subject ownership, and creates a server session. */
export async function completeGoogleSignIn({ subject, email, authority, hostedDomain }, nonce) {
  if (typeof subject !== "string" || !subject || typeof email !== "string" || !email || typeof nonce !== "string" || !["gmail", "workspace", "external"].includes(authority)) return null;
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const consumed = await client.query("UPDATE google_login_nonces SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > now() RETURNING token_hash", [customerTokenHash(nonce)]);
    if (!consumed.rows[0]) { await client.query("ROLLBACK"); return null; }
    const bySubject = await client.query("SELECT id,email FROM subscriber_identities WHERE google_subject=$1 FOR UPDATE", [subject]);
    const byEmail = await client.query("SELECT id,google_subject FROM subscriber_identities WHERE email=$1 FOR UPDATE", [email]);
    let identity;
    if (bySubject.rows[0]) {
      if (byEmail.rows[0] && byEmail.rows[0].id !== bySubject.rows[0].id) { await client.query("ROLLBACK"); return null; }
      identity = (await client.query("UPDATE subscriber_identities SET email=$2,google_email_authority=$3,google_hosted_domain=$4,verified_at=now() WHERE id=$1 RETURNING id", [bySubject.rows[0].id, email, authority, hostedDomain || null])).rows[0];
    } else if (byEmail.rows[0]) {
      if (byEmail.rows[0].google_subject) { await client.query("ROLLBACK"); return null; }
      identity = (await client.query("UPDATE subscriber_identities SET google_subject=$2,google_email_authority=$3,google_hosted_domain=$4,verified_at=now() WHERE id=$1 RETURNING id", [byEmail.rows[0].id, subject, authority, hostedDomain || null])).rows[0];
    } else {
      identity = (await client.query("INSERT INTO subscriber_identities (id,email,google_subject,google_email_authority,google_hosted_domain,verified_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id", [newId(), email, subject, authority, hostedDomain || null])).rows[0];
    }
    // Payment ownership is never inferred from a Google/Dodo email match. A
    // Stage 2B checkout correlation must be provider-proven before linking.
    const session = newToken();
    await client.query(`INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now() + ($4 * interval '1 day'))`, [newId(), identity.id, customerTokenHash(session), CUSTOMER_SESSION_DAYS]);
    await client.query("COMMIT"); return session;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function createEditingSession(jobId, initialPrompt, subscriberId = null) {
  const id = newId(); const accessToken = newToken();
  const { rows } = await database().query(`INSERT INTO editing_sessions (id, access_token, source_job_id, subscriber_id, latest_version)
    VALUES ($1,$2,$3,$4,1) RETURNING *`, [id, accessToken, jobId, subscriberId]);
  await database().query("UPDATE edit_jobs SET session_id=$2 WHERE id=$1", [jobId, id]);
  await database().query("INSERT INTO editing_versions (session_id, version, job_id, prompt, status) VALUES ($1,1,$2,$3,'queued')", [id, jobId, initialPrompt]);
  return { id: rows[0].id, accessToken, version: 1 };
}
export async function getAuthorizedSession(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const { rows } = await database().query("SELECT * FROM editing_sessions WHERE id=$1 AND access_token=$2 AND expires_at > now()", [id, token]);
  return rows[0] || null;
}
export async function getAuthorizedSubscriberSession(id, token, subscriberId) {
  if (!UUID_PATTERN.test(id) || !token || !subscriberId) return null;
  const { rows } = await database().query("SELECT * FROM editing_sessions WHERE id=$1 AND access_token=$2 AND subscriber_id=$3 AND expires_at > now()", [id, token, subscriberId]);
  return rows[0] || null;
}
export async function getSessionHistory(id) {
  const { rows } = await database().query(`SELECT v.version,v.job_id,v.prompt,v.plan,v.confirmation,v.status,v.created_at,j.output_key,j.output_cleaned_at,j.source_catalog
    FROM editing_versions v JOIN edit_jobs j ON j.id=v.job_id WHERE v.session_id=$1 ORDER BY v.version`, [id]);
  return rows;
}
export async function createConversationJob(session, { prompt, plan, confirmation, expectedVersion, subscriberId = null, reservationId = null }) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM editing_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    if (!locked.rows[0] || locked.rows[0].latest_version < 1 || locked.rows[0].latest_version !== expectedVersion) {
      await client.query("ROLLBACK");
      return null;
    }
    // Check the authoritative job status while holding the same session lock.
    // A caller knowing the new version must not queue another delta on an
    // unfinished edit, even while the worker's version mirror is catching up.
    const pending = await client.query(`SELECT j.status FROM editing_versions v JOIN edit_jobs j ON j.id=v.job_id
      WHERE v.session_id=$1 AND j.status IN ('uploading','queued','analyzing','rendering') LIMIT 1`, [session.id]);
    if (pending.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const source = await client.query("SELECT * FROM edit_jobs WHERE id=$1", [locked.rows[0].source_job_id]);
    if (!source.rows[0]) throw new Error("Original media is no longer available");
    const id = newId(); const accessToken = newToken(); const version = locked.rows[0].latest_version + 1;
    const result = await client.query(`INSERT INTO edit_jobs (id,access_token,status,prompt,export_quality,sources,reference,session_id,edit_plan,source_catalog,subscriber_id,quota_reservation_id)
      VALUES ($1,$2,'queued',$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11) RETURNING *`, [id, accessToken, prompt, source.rows[0].export_quality, JSON.stringify(source.rows[0].sources), JSON.stringify(source.rows[0].reference), session.id, JSON.stringify(plan), JSON.stringify(source.rows[0].source_catalog), subscriberId, reservationId]);
    if (reservationId) { const attached = await client.query("UPDATE render_quota_reservations SET job_id=$2,updated_at=now() WHERE id=$1 AND subscriber_id=$3 AND job_id IS NULL AND state='reserved' RETURNING id", [reservationId, id, subscriberId]); if (!attached.rowCount) throw new Error("Render quota reservation is unavailable"); }
    await client.query("INSERT INTO editing_versions (session_id,version,job_id,prompt,plan,confirmation,status) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'queued')", [session.id, version, id, prompt, JSON.stringify(plan), confirmation]);
    await client.query("UPDATE editing_sessions SET latest_version=$2, updated_at=now() WHERE id=$1", [session.id, version]);
    await client.query("COMMIT");
    return { job: safeRow(result.rows[0]), accessToken, version };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function saveJobPlan(id, workerId, plan, sourceCatalog) {
  const { rows } = await database().query("UPDATE edit_jobs SET edit_plan=$3, source_catalog=$4::jsonb WHERE id=$1 AND worker_id=$2 RETURNING session_id", [id, workerId, JSON.stringify(plan), JSON.stringify(sourceCatalog)]);
  if (rows[0]?.session_id) await database().query("UPDATE editing_versions SET plan=$3::jsonb WHERE session_id=$1 AND job_id=$2", [rows[0].session_id, id, JSON.stringify(plan)]);
}
export async function syncVersionStatus(id, status) {
  await database().query("UPDATE editing_versions SET status=$2 WHERE job_id=$1", [id, status]);
}
export async function getJobConfirmation(id) {
  const { rows } = await database().query("SELECT confirmation FROM editing_versions WHERE job_id=$1", [id]);
  return rows[0]?.confirmation || null;
}
export async function createUploadJob(sources, reference = null, { subscriberId = null, reservationId = null } = {}) {
  const id = newId(); const accessToken = newToken();
  const { rows } = await database().query("INSERT INTO edit_jobs (id, access_token, status, sources, reference, subscriber_id, quota_reservation_id) VALUES ($1,$2,'uploading',$3::jsonb,$4::jsonb,$5,$6) RETURNING *", [id, accessToken, JSON.stringify(sources), JSON.stringify(reference), subscriberId, reservationId]);
  await attachReservationToJob(reservationId, id, subscriberId);
  return { job: safeRow(rows[0]), accessToken };
}
export async function getAuthorizedJob(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const { rows } = await database().query("SELECT * FROM edit_jobs WHERE id = $1 AND access_token = $2", [id, token]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function getAuthorizedSubscriberJob(id, token, subscriberId) {
  if (!UUID_PATTERN.test(id) || !token || !subscriberId) return null;
  const { rows } = await database().query("SELECT * FROM edit_jobs WHERE id=$1 AND access_token=$2 AND subscriber_id=$3", [id, token, subscriberId]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function cancelAuthorizedJob(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const client = await database().connect(); let rows;
  try { await client.query("BEGIN");
  ({ rows } = await client.query(`UPDATE edit_jobs SET status='cancelled', error_message=NULL, updated_at=now()
    WHERE id=$1 AND access_token=$2 AND status IN ('uploading','queued','analyzing','rendering') RETURNING *`, [id, token]));
  if (rows[0]) {
    await client.query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE job_id=$1 AND state='reserved'", [id]);
    await client.query("UPDATE editing_versions SET status='cancelled' WHERE job_id=$1", [id]);
    await client.query("COMMIT"); return { job: safeRow(rows[0]), cancelled: true };
  }
  await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const job = await getAuthorizedJob(id, token);
  return job ? { job, cancelled: false } : null;
}
export async function isJobCancelled(id, workerId) {
  const { rows } = await database().query("SELECT status FROM edit_jobs WHERE id=$1 AND worker_id=$2", [id, workerId]);
  return rows[0]?.status === "cancelled";
}
export async function setUploadSources(id, sources, reference) {
  const { rows } = await database().query("UPDATE edit_jobs SET sources=$2::jsonb, reference=$3::jsonb, updated_at=now() WHERE id=$1 RETURNING *", [id, JSON.stringify(sources), JSON.stringify(reference ?? null)]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function queueJob(id, { prompt, exportQuality, sources, reference = null }) {
  const { rows } = await database().query(`UPDATE edit_jobs SET status='queued', prompt=$2, export_quality=$3, sources=$4::jsonb, reference=$5::jsonb, error_message=NULL, worker_id=NULL, claimed_at=NULL, heartbeat_at=NULL, updated_at=now() WHERE id=$1 AND status='uploading' RETURNING *`, [id, prompt, exportQuality, JSON.stringify(sources), JSON.stringify(reference)]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function failUploadJob(id, message) { const client = await database().connect(); try { await client.query("BEGIN"); const { rows } = await client.query("UPDATE edit_jobs SET status='failed', error_message=$2, updated_at=now() WHERE id=$1 AND status='uploading' RETURNING id", [id, message]); if (rows[0]) await client.query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE job_id=$1 AND state='reserved'", [id]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
export async function claimNextJob(workerId) {
  const { rows } = await database().query(`WITH next_job AS (
    SELECT j.id FROM edit_jobs j WHERE j.status='queued' AND (($3 = false AND j.subscriber_id IS NULL) OR EXISTS (
      SELECT 1 FROM render_quota_reservations r JOIN dodo_subscriptions s ON s.dodo_subscription_id=r.subscription_id JOIN subscriber_identities i ON i.id=j.subscriber_id
      WHERE r.id=j.quota_reservation_id AND r.job_id=j.id AND r.state='reserved' AND s.subscriber_id=j.subscriber_id
        AND s.status='active' AND s.ownership_provenance='verified' AND s.product_id=$2 AND s.billing_period_end > now()
        AND s.billing_period_start <= now() AND i.verified_at IS NOT NULL AND i.google_subject IS NOT NULL
    )) ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE edit_jobs j SET status='analyzing', worker_id=$1, claimed_at=now(), heartbeat_at=now(), attempt_count=attempt_count+1, updated_at=now() FROM next_job WHERE j.id=next_job.id RETURNING j.*`, [workerId, dodoProductId(), paidEditingEnforced()]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function setJobStatus(id, workerId, status) {
  const { rows } = await database().query("UPDATE edit_jobs SET status=$3, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='analyzing' RETURNING *", [id, workerId, status]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function heartbeatJob(id, workerId) { await database().query("UPDATE edit_jobs SET heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status IN ('analyzing','rendering')", [id, workerId]); }
export async function completeJob(id, workerId, outputKey) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("UPDATE edit_jobs SET status='completed', output_key=$3, error_message=NULL, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='rendering' RETURNING *", [id, workerId, outputKey]);
    if (rows[0] && rows[0].quota_reservation_id) {
      const consumed = await client.query("UPDATE render_quota_reservations SET state='consumed',updated_at=now() WHERE id=$1 AND job_id=$2 AND state='reserved' RETURNING id", [rows[0].quota_reservation_id, id]);
      if (!consumed.rowCount) throw new Error("Render quota reservation is unavailable");
    }
    await client.query("COMMIT"); return rows[0] ? safeRow(rows[0]) : null;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function failJob(id, workerId, message) {
  const client = await database().connect(); try { await client.query("BEGIN");
    const { rows } = await client.query("UPDATE edit_jobs SET status='failed', error_message=$3, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status IN ('analyzing','rendering') RETURNING id", [id, workerId, message]);
    if (rows[0]) await client.query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE job_id=$1 AND state='reserved'", [id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function recoverStaleJobs({ staleAfterMs, maxAttempts }) {
  const client = await database().connect(); try { await client.query("BEGIN");
    const { rows } = await client.query(`UPDATE edit_jobs SET status=CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'queued' END, error_message=CASE WHEN attempt_count >= $2 THEN 'Processing was interrupted. Please submit the edit again.' ELSE NULL END, worker_id=NULL, claimed_at=NULL, heartbeat_at=NULL, updated_at=now() WHERE status IN ('analyzing','rendering') AND heartbeat_at < now() - ($1 * interval '1 millisecond') RETURNING *`, [staleAfterMs, maxAttempts]);
    const failed = rows.filter((row) => row.status === "failed").map((row) => row.id);
    if (failed.length) await client.query("UPDATE render_quota_reservations SET state='released',updated_at=now() WHERE job_id = ANY($1::uuid[]) AND state='reserved'", [failed]);
    await client.query("COMMIT"); return rows.map(safeRow);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function getAbandonedUploads(sourceRetentionHours) {
  const { rows } = await database().query("SELECT * FROM edit_jobs WHERE status='uploading' AND updated_at < now() - ($1 * interval '1 hour') LIMIT 25", [sourceRetentionHours]);
  return rows.map(safeRow);
}
export async function expireUploadJob(id) { return failUploadJob(id, "Upload expired before it was completed"); }
export async function getJobsForCleanup({ sourceRetentionHours, outputRetentionHours }) {
  const { rows } = await database().query(`SELECT j.* FROM edit_jobs j LEFT JOIN editing_sessions s ON s.id=j.session_id WHERE ((j.status IN ('completed','failed','cancelled') AND j.source_cleaned_at IS NULL AND j.updated_at < now() - ($1 * interval '1 hour') AND (j.session_id IS NULL OR s.expires_at <= now())) OR (j.status='completed' AND j.output_key IS NOT NULL AND j.output_cleaned_at IS NULL AND j.updated_at < now() - ($2 * interval '1 hour'))) LIMIT 25`, [sourceRetentionHours, outputRetentionHours]);
  return rows.map(safeRow);
}
export async function markSourcesCleaned(id) { await database().query("UPDATE edit_jobs SET source_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }
export async function markOutputCleaned(id) { await database().query("UPDATE edit_jobs SET output_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }

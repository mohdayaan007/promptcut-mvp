import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
let pool;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  return pool;
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
  status TEXT NOT NULL CHECK (status IN ('active','past_due','cancelled','expired')),
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dodo_subscriptions_subscriber_idx ON dodo_subscriptions (subscriber_id, status);
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
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export async function migrateEditJobs() {
  await database().query(EDIT_JOBS_SCHEMA);
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS reference JSONB;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS session_id UUID;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS edit_plan JSONB;");
  await database().query("ALTER TABLE edit_jobs ADD COLUMN IF NOT EXISTS source_catalog JSONB;");
  await database().query("ALTER TABLE dodo_subscriptions ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ NOT NULL DEFAULT now();");
  await database().query(`ALTER TABLE edit_jobs DROP CONSTRAINT IF EXISTS edit_jobs_status_check;
    ALTER TABLE edit_jobs ADD CONSTRAINT edit_jobs_status_check
    CHECK (status IN ('uploading','queued','analyzing','rendering','completed','failed','cancelled'));`);
}

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
export async function processDodoWebhookEvent(eventId, eventType, rawBody, subscription) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const inserted = await client.query(`INSERT INTO dodo_webhook_events (event_id,event_type,payload_sha256)
      VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`, [eventId, eventType, hash]);
    if (!inserted.rowCount) { await client.query("COMMIT"); return false; }
    if (subscription) await client.query(`INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,customer_email,status,last_event_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (dodo_subscription_id) DO UPDATE SET product_id=EXCLUDED.product_id,dodo_customer_id=EXCLUDED.dodo_customer_id,
        customer_email=COALESCE(EXCLUDED.customer_email,dodo_subscriptions.customer_email),status=EXCLUDED.status,last_event_at=EXCLUDED.last_event_at,updated_at=now()
      WHERE EXCLUDED.last_event_at > dodo_subscriptions.last_event_at`,
    [subscription.subscriptionId, subscription.productId, subscription.customerId, subscription.email, subscription.status, subscription.occurredAt]);
    await client.query("COMMIT"); return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function createEditingSession(jobId, initialPrompt) {
  const id = newId(); const accessToken = newToken();
  const { rows } = await database().query(`INSERT INTO editing_sessions (id, access_token, source_job_id, latest_version)
    VALUES ($1,$2,$3,1) RETURNING *`, [id, accessToken, jobId]);
  await database().query("UPDATE edit_jobs SET session_id=$2 WHERE id=$1", [jobId, id]);
  await database().query("INSERT INTO editing_versions (session_id, version, job_id, prompt, status) VALUES ($1,1,$2,$3,'queued')", [id, jobId, initialPrompt]);
  return { id: rows[0].id, accessToken, version: 1 };
}
export async function getAuthorizedSession(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const { rows } = await database().query("SELECT * FROM editing_sessions WHERE id=$1 AND access_token=$2 AND expires_at > now()", [id, token]);
  return rows[0] || null;
}
export async function getSessionHistory(id) {
  const { rows } = await database().query(`SELECT v.version,v.job_id,v.prompt,v.plan,v.confirmation,v.status,v.created_at,j.output_key,j.output_cleaned_at,j.source_catalog
    FROM editing_versions v JOIN edit_jobs j ON j.id=v.job_id WHERE v.session_id=$1 ORDER BY v.version`, [id]);
  return rows;
}
export async function createConversationJob(session, { prompt, plan, confirmation, expectedVersion }) {
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
    const result = await client.query(`INSERT INTO edit_jobs (id,access_token,status,prompt,export_quality,sources,reference,session_id,edit_plan,source_catalog)
      VALUES ($1,$2,'queued',$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb) RETURNING *`, [id, accessToken, prompt, source.rows[0].export_quality, JSON.stringify(source.rows[0].sources), JSON.stringify(source.rows[0].reference), session.id, JSON.stringify(plan), JSON.stringify(source.rows[0].source_catalog)]);
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
export async function createUploadJob(sources, reference = null) {
  const id = newId(); const accessToken = newToken();
  const { rows } = await database().query("INSERT INTO edit_jobs (id, access_token, status, sources, reference) VALUES ($1,$2,'uploading',$3::jsonb,$4::jsonb) RETURNING *", [id, accessToken, JSON.stringify(sources), JSON.stringify(reference)]);
  return { job: safeRow(rows[0]), accessToken };
}
export async function getAuthorizedJob(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const { rows } = await database().query("SELECT * FROM edit_jobs WHERE id = $1 AND access_token = $2", [id, token]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function cancelAuthorizedJob(id, token) {
  if (!UUID_PATTERN.test(id) || !token) return null;
  const { rows } = await database().query(`UPDATE edit_jobs SET status='cancelled', error_message=NULL, updated_at=now()
    WHERE id=$1 AND access_token=$2 AND status IN ('uploading','queued','analyzing','rendering') RETURNING *`, [id, token]);
  if (rows[0]) {
    await database().query("UPDATE editing_versions SET status='cancelled' WHERE job_id=$1", [id]);
    return { job: safeRow(rows[0]), cancelled: true };
  }
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
export async function failUploadJob(id, message) { await database().query("UPDATE edit_jobs SET status='failed', error_message=$2, updated_at=now() WHERE id=$1 AND status='uploading'", [id, message]); }
export async function claimNextJob(workerId) {
  const { rows } = await database().query(`WITH next_job AS (SELECT id FROM edit_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE edit_jobs j SET status='analyzing', worker_id=$1, claimed_at=now(), heartbeat_at=now(), attempt_count=attempt_count+1, updated_at=now() FROM next_job WHERE j.id=next_job.id RETURNING j.*`, [workerId]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function setJobStatus(id, workerId, status) {
  const { rows } = await database().query("UPDATE edit_jobs SET status=$3, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='analyzing' RETURNING *", [id, workerId, status]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function heartbeatJob(id, workerId) { await database().query("UPDATE edit_jobs SET heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status IN ('analyzing','rendering')", [id, workerId]); }
export async function completeJob(id, workerId, outputKey) {
  const { rows } = await database().query("UPDATE edit_jobs SET status='completed', output_key=$3, error_message=NULL, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status='rendering' RETURNING *", [id, workerId, outputKey]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function failJob(id, workerId, message) { await database().query("UPDATE edit_jobs SET status='failed', error_message=$3, heartbeat_at=now(), updated_at=now() WHERE id=$1 AND worker_id=$2 AND status IN ('analyzing','rendering')", [id, workerId, message]); }
export async function recoverStaleJobs({ staleAfterMs, maxAttempts }) {
  const { rows } = await database().query(`UPDATE edit_jobs SET status=CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'queued' END, error_message=CASE WHEN attempt_count >= $2 THEN 'Processing was interrupted. Please submit the edit again.' ELSE NULL END, worker_id=NULL, claimed_at=NULL, heartbeat_at=NULL, updated_at=now() WHERE status IN ('analyzing','rendering') AND heartbeat_at < now() - ($1 * interval '1 millisecond') RETURNING *`, [staleAfterMs, maxAttempts]);
  return rows.map(safeRow);
}
export async function getAbandonedUploads(sourceRetentionHours) {
  const { rows } = await database().query("SELECT * FROM edit_jobs WHERE status='uploading' AND updated_at < now() - ($1 * interval '1 hour') LIMIT 25", [sourceRetentionHours]);
  return rows.map(safeRow);
}
export async function expireUploadJob(id) {
  await database().query("UPDATE edit_jobs SET status='failed', error_message='Upload expired before it was completed', updated_at=now() WHERE id=$1 AND status='uploading'", [id]);
}
export async function getJobsForCleanup({ sourceRetentionHours, outputRetentionHours }) {
  const { rows } = await database().query(`SELECT j.* FROM edit_jobs j LEFT JOIN editing_sessions s ON s.id=j.session_id WHERE ((j.status IN ('completed','failed','cancelled') AND j.source_cleaned_at IS NULL AND j.updated_at < now() - ($1 * interval '1 hour') AND (j.session_id IS NULL OR s.expires_at <= now())) OR (j.status='completed' AND j.output_key IS NOT NULL AND j.output_cleaned_at IS NULL AND j.updated_at < now() - ($2 * interval '1 hour'))) LIMIT 25`, [sourceRetentionHours, outputRetentionHours]);
  return rows.map(safeRow);
}
export async function markSourcesCleaned(id) { await database().query("UPDATE edit_jobs SET source_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }
export async function markOutputCleaned(id) { await database().query("UPDATE edit_jobs SET output_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }

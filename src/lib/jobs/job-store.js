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
  output_key TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  source_cleaned_at TIMESTAMPTZ,
  output_cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edit_jobs_queue_idx ON edit_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS edit_jobs_cleanup_idx ON edit_jobs (status, updated_at);
`;

function newId() { return crypto.randomUUID(); }
function newToken() { return crypto.randomBytes(32).toString("base64url"); }
function safeRow(row) {
  return {
    id: row.id, status: row.status, prompt: row.prompt, exportQuality: row.export_quality,
    sources: row.sources, outputKey: row.output_key, errorMessage: row.error_message,
    attemptCount: row.attempt_count, workerId: row.worker_id, claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at, sourceCleanedAt: row.source_cleaned_at,
    outputCleanedAt: row.output_cleaned_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export async function migrateEditJobs() {
  await database().query(EDIT_JOBS_SCHEMA);
  await database().query(`ALTER TABLE edit_jobs DROP CONSTRAINT IF EXISTS edit_jobs_status_check;
    ALTER TABLE edit_jobs ADD CONSTRAINT edit_jobs_status_check
    CHECK (status IN ('uploading','queued','analyzing','rendering','completed','failed','cancelled'));`);
}
export async function createUploadJob(sources) {
  const id = newId(); const accessToken = newToken();
  const { rows } = await database().query("INSERT INTO edit_jobs (id, access_token, status, sources) VALUES ($1,$2,'uploading',$3::jsonb) RETURNING *", [id, accessToken, JSON.stringify(sources)]);
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
  if (rows[0]) return { job: safeRow(rows[0]), cancelled: true };
  const job = await getAuthorizedJob(id, token);
  return job ? { job, cancelled: false } : null;
}
export async function isJobCancelled(id, workerId) {
  const { rows } = await database().query("SELECT status FROM edit_jobs WHERE id=$1 AND worker_id=$2", [id, workerId]);
  return rows[0]?.status === "cancelled";
}
export async function setUploadSources(id, sources) {
  const { rows } = await database().query("UPDATE edit_jobs SET sources=$2::jsonb, updated_at=now() WHERE id=$1 RETURNING *", [id, JSON.stringify(sources)]);
  return rows[0] ? safeRow(rows[0]) : null;
}
export async function queueJob(id, { prompt, exportQuality, sources }) {
  const { rows } = await database().query(`UPDATE edit_jobs SET status='queued', prompt=$2, export_quality=$3, sources=$4::jsonb, error_message=NULL, worker_id=NULL, claimed_at=NULL, heartbeat_at=NULL, updated_at=now() WHERE id=$1 AND status='uploading' RETURNING *`, [id, prompt, exportQuality, JSON.stringify(sources)]);
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
  const { rows } = await database().query(`SELECT * FROM edit_jobs WHERE ((status IN ('completed','failed','cancelled') AND source_cleaned_at IS NULL AND updated_at < now() - ($1 * interval '1 hour')) OR (status='completed' AND output_key IS NOT NULL AND output_cleaned_at IS NULL AND updated_at < now() - ($2 * interval '1 hour'))) LIMIT 25`, [sourceRetentionHours, outputRetentionHours]);
  return rows.map(safeRow);
}
export async function markSourcesCleaned(id) { await database().query("UPDATE edit_jobs SET source_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }
export async function markOutputCleaned(id) { await database().query("UPDATE edit_jobs SET output_cleaned_at=now(), updated_at=now() WHERE id=$1", [id]); }

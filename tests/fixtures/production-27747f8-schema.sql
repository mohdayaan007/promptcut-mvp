-- Exact EDIT_JOBS_SCHEMA from deployed production commit 27747f8674dfe391acb6b2a0e088965fe6d32121

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

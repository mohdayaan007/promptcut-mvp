import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { migrateEditJobs, closeJobStorePool } from "@/lib/jobs/job-store";

test("production editor schema migrates additively without altering historical jobs or sessions", async () => {
  if (!process.env.DATABASE_URL?.includes("cliponaut_paid_period") || process.env.CLIPONAUT_ISOLATED_BILLING_TESTS !== "true") throw new Error("Disposable paid-period database required");
  const original = process.env.DATABASE_URL;
  const schema = `migration_${crypto.randomBytes(8).toString("hex")}`;
  const db = new Client({ connectionString: original });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(fs.readFileSync("tests/fixtures/production-27747f8-schema.sql", "utf8"));
    const jobId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    await db.query("INSERT INTO edit_jobs(id,access_token,status,output_key,export_quality) VALUES($1,'opaque-fixture-token','completed','private-fixture-output','4k')", [jobId]);
    await db.query("INSERT INTO editing_sessions(id,access_token,source_job_id) VALUES($1,'opaque-session-fixture',$2)", [sessionId, jobId]);
    const beforeJobs = (await db.query("SELECT * FROM edit_jobs")).rows;
    const beforeSessions = (await db.query("SELECT * FROM editing_sessions")).rows;
    const url = new URL(original);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    await migrateEditJobs();
    await migrateEditJobs();
    const job = (await db.query("SELECT * FROM edit_jobs")).rows[0];
    assert.equal(job.subscriber_id, null);
    assert.equal(job.quota_reservation_id, null);
    for (const [key,value] of Object.entries(beforeJobs[0])) assert.deepEqual(job[key], value, key);
    const session = (await db.query("SELECT * FROM editing_sessions")).rows[0];
    for (const [key,value] of Object.entries(beforeSessions[0])) assert.deepEqual(session[key], value, key);
    assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n, 0);
  } finally {
    await closeJobStorePool();
    process.env.DATABASE_URL = original;
    await db.query("SET search_path TO public");
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});

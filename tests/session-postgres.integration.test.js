import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { grantFounderTestAccess } from "../src/lib/founder-test-access.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for this integration test");

const { Client } = pg;
process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED = "true";
process.env.FOUNDER_TEST_ACCESS_SECRET = "founder-test-secret-that-is-long-enough-for-session-integration";
const founderCookie = grantFounderTestAccess(process.env.FOUNDER_TEST_ACCESS_SECRET).split(";", 1)[0];
const catalog = [{ sourceId: "source-1", index: 0, ordinal: 1, filename: "fixture.mp4", duration: 30, width: 320, height: 180, hasAudio: false }];
const plan = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 30 }] }] };

function routeRequest(session, prompt, expectedVersion) {
  return new Request(`http://localhost/api/editing-sessions/${session.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cliponaut-session-token": session.accessToken, cookie: founderCookie },
    body: JSON.stringify({ prompt, expectedVersion })
  });
}

test("PostgreSQL session API atomically versions concurrent turns, recovers after failure, and retains sources until expiry", async () => {
  const store = await import("@/lib/jobs/job-store");
  const sessionRoute = await import("@/app/api/editing-sessions/[id]/route");
  await store.migrateEditJobs();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const created = await store.createUploadJob([{ index: 0, name: "fixture.mp4", type: "video/mp4", size: 10 }]);
    await client.query(`UPDATE edit_jobs SET status='completed', edit_plan=$2::jsonb, source_catalog=$3::jsonb, updated_at=now() - interval '48 hours' WHERE id=$1`, [created.job.id, JSON.stringify(plan), JSON.stringify(catalog)]);
    const session = await store.createEditingSession(created.job.id, "Keep only Ahmed Perfumes.");
    await client.query("UPDATE editing_versions SET status='completed', plan=$2::jsonb WHERE session_id=$1 AND version=1", [session.id, JSON.stringify(plan)]);

    const unsupported = await sessionRoute.POST(routeRequest(session, "Make it amazing somehow", 1), { params: Promise.resolve({ id: session.id }) });
    assert.equal(unsupported.status, 422, "unsupported instructions are safe client errors, not server failures");
    assert.match((await unsupported.json()).error, /couldn’t safely/i);
    assert.equal((await store.getSessionHistory(session.id)).length, 1, "a rejected turn never creates a version");

    const [first, second] = await Promise.all([
      sessionRoute.POST(routeRequest(session, "Also add black and white.", 1), { params: Promise.resolve({ id: session.id }) }),
      sessionRoute.POST(routeRequest(session, "Replace that with the cinematic style.", 1), { params: Promise.resolve({ id: session.id }) })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409], "only one same-version prompt is accepted");
    const accepted = await (first.status === 200 ? first : second).json();
    assert.equal(accepted.version, 2);
    await client.query("UPDATE edit_jobs SET status='failed' WHERE id=$1", [accepted.id]);
    await client.query("UPDATE editing_versions SET status='failed' WHERE job_id=$1", [accepted.id]);

    const recovered = await sessionRoute.POST(routeRequest({ ...session, version: 2 }, "Trim the first five seconds.", 2), { params: Promise.resolve({ id: session.id }) });
    assert.equal(recovered.status, 200, "a failed latest turn resumes from the last completed version");
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.version, 3);
    const stored = await store.getSessionHistory(session.id);
    assert.deepEqual(stored.map((entry) => entry.status), ["completed", "failed", "queued"]);

    let cleanup = await store.getJobsForCleanup({ sourceRetentionHours: 1, outputRetentionHours: 1 });
    assert.equal(cleanup.some((job) => job.id === created.job.id), false, "active session retains original media");
    await client.query("UPDATE editing_sessions SET expires_at=now() - interval '1 hour' WHERE id=$1", [session.id]);
    cleanup = await store.getJobsForCleanup({ sourceRetentionHours: 1, outputRetentionHours: 1 });
    assert.equal(cleanup.some((job) => job.id === created.job.id), true, "expired session releases original media for cleanup");

    const historyResponse = await sessionRoute.GET(new Request(`http://localhost/api/editing-sessions/${session.id}`, { headers: { "x-cliponaut-session-token": session.accessToken, cookie: founderCookie } }), { params: Promise.resolve({ id: session.id }) });
    assert.equal(historyResponse.status, 404, "expired session cannot disclose history");
  } finally { await client.end(); }
});

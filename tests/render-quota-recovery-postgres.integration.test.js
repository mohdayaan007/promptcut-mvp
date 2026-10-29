import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { claimNextJob, closeJobStorePool, completeJob, createUploadJob, expireUploadJob, failUploadJob, migrateEditJobs, recoverStaleJobs, reserveRenderCapacity, setJobStatus } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
const OWNER = "44444444-4444-4444-8444-444444444444";
async function fixture() {
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product"; process.env.PAID_RENDER_ALLOWANCE = "15";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
  await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'recovery@example.test','google-recovery',now())", [OWNER]);
  await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-recovery','cliponaut-product',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [OWNER]);
  return db;
}
async function reservedJob(db, { stale = false, attempts = 0, upload = false } = {}) {
  const reservation = await reserveRenderCapacity(OWNER); assert.ok(reservation);
  const created = await createUploadJob([], null, { subscriberId: OWNER, reservationId: reservation });
  if (!upload) await db.query("UPDATE edit_jobs SET status='analyzing',worker_id='dead-worker',attempt_count=$2,heartbeat_at=now()-interval '2 hours' WHERE id=$1", [created.job.id, attempts]);
  return { ...created, reservation };
}
async function state(db, reservation) { return (await db.query("SELECT state FROM render_quota_reservations WHERE id=$1", [reservation])).rows[0].state; }

integration("recovery 1: retryable stale job is queued and retains reservation", async () => {
  const db = await fixture(); try { const job = await reservedJob(db, { attempts: 1 }); await recoverStaleJobs({ staleAfterMs: 1000, maxAttempts: 3 });
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "queued"); assert.equal(await state(db, job.reservation), "reserved");
  } finally { await db.end(); await closeJobStorePool(); }
});
integration("recovery 2: permanent stale failure releases reservation", async () => {
  const db = await fixture(); try { const job = await reservedJob(db, { attempts: 3 }); await recoverStaleJobs({ staleAfterMs: 1000, maxAttempts: 3 });
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "failed"); assert.equal(await state(db, job.reservation), "released");
  } finally { await db.end(); await closeJobStorePool(); }
});
integration("recovery 3: retry then success consumes exactly once", async () => {
  const db = await fixture(); try { const job = await reservedJob(db, { attempts: 1 }); await recoverStaleJobs({ staleAfterMs: 1000, maxAttempts: 3 });
    const claimed = await claimNextJob("retry-worker"); assert.equal(claimed.id, job.job.id); assert.ok(await setJobStatus(job.job.id, "retry-worker", "rendering")); assert.ok(await completeJob(job.job.id, "retry-worker", "outputs/recovered.mp4"));
    assert.equal(await state(db, job.reservation), "consumed"); assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE job_id=$1 AND state='consumed'", [job.job.id])).rows[0].count, 1);
  } finally { await db.end(); await closeJobStorePool(); }
});
integration("recovery 4: expired upload releases once", async () => {
  const db = await fixture(); try { const job = await reservedJob(db, { upload: true }); await expireUploadJob(job.job.id); await expireUploadJob(job.job.id);
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "failed"); assert.equal(await state(db, job.reservation), "released");
  } finally { await db.end(); await closeJobStorePool(); }
});
integration("recovery 5: failed upload releases once", async () => {
  const db = await fixture(); try { const job = await reservedJob(db, { upload: true }); await failUploadJob(job.job.id, "synthetic upload failure"); await failUploadJob(job.job.id, "repeat");
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "failed"); assert.equal(await state(db, job.reservation), "released");
  } finally { await db.end(); await closeJobStorePool(); }
});
integration("recovery 6: repeated recovery leaves recovered and terminal accounting unchanged", async () => {
  const db = await fixture(); try { const retryable = await reservedJob(db, { attempts: 1 }); const terminal = await reservedJob(db, { attempts: 3 });
    await recoverStaleJobs({ staleAfterMs: 1000, maxAttempts: 3 }); await recoverStaleJobs({ staleAfterMs: 1000, maxAttempts: 3 });
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [retryable.job.id])).rows[0].status, "queued"); assert.equal(await state(db, retryable.reservation), "reserved");
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [terminal.job.id])).rows[0].status, "failed"); assert.equal(await state(db, terminal.reservation), "released");
    assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations")).rows[0].count, 2);
  } finally { await db.end(); await closeJobStorePool(); }
});

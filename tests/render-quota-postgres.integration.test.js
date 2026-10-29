import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { cancelAuthorizedJob, closeJobStorePool, completeJob, createUploadJob, failJob, migrateEditJobs, reserveRenderCapacity } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("PostgreSQL render reservations serialize capacity and isolate subscribers", async () => {
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  process.env.PAID_RENDER_ALLOWANCE = "15";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    for (const id of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) await db.query("INSERT INTO subscriber_identities (id,email) VALUES ($1,$2)", [id, `${id}@example.test`]);
    for (const [sub, owner] of [["sub-a","11111111-1111-4111-8111-111111111111"],["sub-b","22222222-2222-4222-8222-222222222222"]]) await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ($1,'cliponaut-product',$2,'verified','active',now()-interval '1 day',now()+interval '29 days')", [sub, owner]);
    const owner = "11111111-1111-4111-8111-111111111111";
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveRenderCapacity(owner)));
    assert.equal(results.filter(Boolean).length, 15);
    assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE subscriber_id=$1 AND state='reserved'", [owner])).rows[0].count, 15);
    assert.equal(await reserveRenderCapacity(owner), null);
    assert.ok(await reserveRenderCapacity("22222222-2222-4222-8222-222222222222"));
    await db.query("UPDATE dodo_subscriptions SET ownership_provenance='unverified' WHERE dodo_subscription_id='sub-b'");
    assert.equal(await reserveRenderCapacity("22222222-2222-4222-8222-222222222222"), null);
  } finally { await db.end(); await closeJobStorePool(); }
});

const OWNER = "33333333-3333-4333-8333-333333333333";
async function quotaFixture() {
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product"; process.env.PAID_RENDER_ALLOWANCE = "15";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
  await db.query("INSERT INTO subscriber_identities (id,email) VALUES ($1,'quota@example.test')", [OWNER]);
  await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-quota','cliponaut-product',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [OWNER]);
  return db;
}
async function reservedRenderingJob(db) {
  const reservation = await reserveRenderCapacity(OWNER); assert.ok(reservation);
  const created = await createUploadJob([], null, { subscriberId: OWNER, reservationId: reservation });
  await db.query("UPDATE edit_jobs SET status='rendering',worker_id='worker-test' WHERE id=$1", [created.job.id]);
  return { ...created, reservation };
}
async function usage(db) { return (await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE state='consumed'")).rows[0].count; }

integration("quota lifecycle 1: successful render atomically consumes its reservation", async () => {
  const db = await quotaFixture(); try {
    const job = await reservedRenderingJob(db); assert.ok(await completeJob(job.job.id, "worker-test", "outputs/success.mp4"));
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "completed");
    assert.equal((await db.query("SELECT state FROM render_quota_reservations WHERE id=$1", [job.reservation])).rows[0].state, "consumed"); assert.equal(await usage(db), 1);
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("quota lifecycle 2: duplicate completion cannot consume twice", async () => {
  const db = await quotaFixture(); try {
    const job = await reservedRenderingJob(db); await completeJob(job.job.id, "worker-test", "outputs/once.mp4");
    assert.equal(await completeJob(job.job.id, "worker-test", "outputs/twice.mp4"), null); assert.equal(await usage(db), 1);
    assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE job_id=$1", [job.job.id])).rows[0].count, 1);
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("quota lifecycle 3: failed render releases its reservation", async () => {
  const db = await quotaFixture(); try {
    const job = await reservedRenderingJob(db); await failJob(job.job.id, "worker-test", "synthetic failure");
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "failed");
    assert.equal((await db.query("SELECT state FROM render_quota_reservations WHERE id=$1", [job.reservation])).rows[0].state, "released"); assert.equal(await usage(db), 0);
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("quota lifecycle 4: cancellation releases exactly once", async () => {
  const db = await quotaFixture(); try {
    const job = await reservedRenderingJob(db); const cancelled = await cancelAuthorizedJob(job.job.id, job.accessToken); assert.equal(cancelled.cancelled, true);
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "cancelled"); assert.equal((await db.query("SELECT state FROM render_quota_reservations WHERE id=$1", [job.reservation])).rows[0].state, "released");
    assert.equal((await cancelAuthorizedJob(job.job.id, job.accessToken)).cancelled, false); assert.equal(await usage(db), 0);
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("quota lifecycle 5: consumption failure rolls back completion and valid retry consumes once", async () => {
  const db = await quotaFixture(); try {
    const job = await reservedRenderingJob(db);
    await db.query("CREATE FUNCTION fail_quota_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic quota failure'; END; $$;");
    await db.query("CREATE TRIGGER fail_quota_consumption BEFORE UPDATE ON render_quota_reservations FOR EACH ROW EXECUTE FUNCTION fail_quota_consumption();");
    await assert.rejects(() => completeJob(job.job.id, "worker-test", "outputs/rollback.mp4"));
    assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1", [job.job.id])).rows[0].status, "rendering"); assert.equal((await db.query("SELECT state FROM render_quota_reservations WHERE id=$1", [job.reservation])).rows[0].state, "reserved");
    await db.query("DROP TRIGGER fail_quota_consumption ON render_quota_reservations; DROP FUNCTION fail_quota_consumption();");
    assert.ok(await completeJob(job.job.id, "worker-test", "outputs/retry.mp4")); assert.equal(await usage(db), 1);
  } finally { await db.end(); await closeJobStorePool(); }
});

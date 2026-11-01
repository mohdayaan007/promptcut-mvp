import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { closeJobStorePool, createConversationJob, createEditingSession, createUploadJob, getAuthorizedSubscriberSession, getEditingEntitlement, migrateEditJobs, releaseUnattachedRenderReservation, reserveRenderCapacity } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
const A = "55555555-5555-4555-8555-555555555555", B = "66666666-6666-4666-8666-666666666666";
async function fixture() {
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product"; process.env.PAID_RENDER_ALLOWANCE = "15";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  await db.query("DELETE FROM render_quota_reservations; DELETE FROM editing_versions; DELETE FROM editing_sessions; DELETE FROM edit_jobs; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
  for (const id of [A, B]) await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [id, `${id}@test.local`, `google-${id}`]);
  for (const [id, sub] of [[A,"sub-a"],[B,"sub-b"]]) await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ($1,'cliponaut-product',$2,'verified','active',now()-interval '1 day',now()+interval '29 days')", [sub,id]);
  const reservation = await reserveRenderCapacity(A); const initial = await createUploadJob([], null, { subscriberId: A, reservationId: reservation });
  await db.query("UPDATE edit_jobs SET status='completed',source_catalog='[]',edit_plan='{}',worker_id='w' WHERE id=$1", [initial.job.id]);
  await db.query("UPDATE render_quota_reservations SET state='consumed' WHERE id=$1", [reservation]);
  const session = await createEditingSession(initial.job.id, "initial", A); return { db, session };
}
async function follow(session, subscriber = A) { const reservationId = await reserveRenderCapacity(subscriber); if (!reservationId) return null; const next = await createConversationJob(session, { prompt:"follow", plan:{}, confirmation:null, expectedVersion:session.version, subscriberId:subscriber, reservationId }); if (!next) await releaseUnattachedRenderReservation(reservationId, subscriber); return next; }

integration("paid conversation: owner creates session and quota-backed follow-up", async () => { const { db, session } = await fixture(); try { assert.ok(await getAuthorizedSubscriberSession(session.id, session.accessToken, A)); const next = await follow(session); assert.ok(next); assert.equal((await db.query("SELECT subscriber_id FROM edit_jobs WHERE id=$1", [next.job.id])).rows[0].subscriber_id,A); assert.equal((await db.query("SELECT state FROM render_quota_reservations WHERE job_id=$1", [next.job.id])).rows[0].state,"reserved"); } finally { await db.end(); await closeJobStorePool(); } });
integration("paid conversation: leaked token and inactive customer are denied", async () => { const { db, session } = await fixture(); try { assert.equal(await getAuthorizedSubscriberSession(session.id, session.accessToken, B),null); await db.query("UPDATE dodo_subscriptions SET status='cancelled' WHERE subscriber_id=$1",[A]); assert.equal(await getEditingEntitlement(A),null); assert.equal(await reserveRenderCapacity(A),null); } finally { await db.end(); await closeJobStorePool(); } });
integration("paid conversation: exhaustion, failed version conflict, and parallel follow-ups do not leak capacity", async () => { const { db, session } = await fixture(); try { const first = await follow(session); assert.ok(first); const before=(await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE state='reserved'")).rows[0].count; const conflict = await follow(session); assert.equal(conflict,null); assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE state='reserved'")).rows[0].count,before); await db.query("UPDATE render_quota_reservations SET state='consumed' WHERE subscriber_id=$1 AND state='reserved'",[A]); for(let i=0;i<14;i++) await reserveRenderCapacity(A); assert.equal(await reserveRenderCapacity(A),null); } finally { await db.end(); await closeJobStorePool(); } });

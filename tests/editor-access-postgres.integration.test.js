import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { editorAccessState } from "@/lib/editor-access-presentation";
import { claimNextJob, closeJobStorePool, completeJob, createUploadJob, failUploadJob, migrateEditJobs, queueJob, reserveRenderCapacity, setJobStatus } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;

integration("editor access is flag-gated and derived from the authenticated customer ledger", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "editor-access-integration-secret-with-at-least-thirty-two", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const { GET } = await import("@/app/api/editor-access/route");
    delete process.env.PAID_EDITING_ENFORCEMENT_ENABLED;
    assert.deepEqual(await (await GET(new Request("http://localhost/api/editor-access"))).json(), { enforced: false });
    process.env.PAID_EDITING_ENFORCEMENT_ENABLED = "true";
    assert.equal((await (await GET(new Request("http://localhost/api/editor-access"))).json()).signedIn, false);
    const subscriber = crypto.randomUUID(); const token = "editor-access-session-token";
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [subscriber, "editor@example.test", "google-editor"]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), subscriber, hashCustomerToken(token)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-editor','cliponaut-product',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [subscriber]);
    const request = () => new Request("http://localhost/api/editor-access", { headers: { cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });
    let access = await (await GET(request())).json(); assert.equal(access.eligible, true); assert.equal(access.usage.remainingRenders, 15);
    const period = (await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub-editor'")).rows[0];
    for (let index = 0; index < 15; index += 1) await db.query("INSERT INTO render_quota_reservations (id,subscriber_id,subscription_id,period_start,period_end,state) VALUES ($1,$2,'sub-editor',$3,$4,'consumed')", [crypto.randomUUID(), subscriber, period.billing_period_start, period.billing_period_end]);
    access = await (await GET(request())).json(); assert.equal(access.eligible, false); assert.equal(access.usage.remainingRenders, 0);
    await db.query("UPDATE dodo_subscriptions SET billing_period_start=now()+interval '1 day',billing_period_end=now()+interval '30 days' WHERE dodo_subscription_id='sub-editor'");
    access = await (await GET(request())).json(); assert.equal(access.eligible, false); assert.equal(access.usage.remainingRenders, null);
  } finally { delete process.env.PAID_EDITING_ENFORCEMENT_ENABLED; await db.end(); await closeJobStorePool(); }
});

integration("initial upload reservations refresh the server-backed editor notice before completion and after abort", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "editor-access-upload-secret-with-at-least-thirty-two", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", PAID_RENDER_ALLOWANCE: "15", PAID_EDITING_ENFORCEMENT_ENABLED: "true" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const { GET } = await import("@/app/api/editor-access/route");
    const subscriber = crypto.randomUUID(); const token = "editor-access-upload-session-token";
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [subscriber, "upload@example.test", "google-upload"]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), subscriber, hashCustomerToken(token)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-upload','cliponaut-product',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [subscriber]);
    const request = () => new Request("http://localhost/api/editor-access", { headers: { cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });

    assert.equal((await (await GET(request())).json()).usage.remainingRenders, 15);
    const abortedReservation = await reserveRenderCapacity(subscriber);
    const { job: uploadingJob } = await createUploadJob([{ index: 0, name: "held.mp4", type: "video/mp4", size: 4 }], null, { subscriberId: subscriber, reservationId: abortedReservation });
    assert.equal(uploadingJob.status, "uploading", "fixture holds multipart upload open");
    let access = await (await GET(request())).json();
    assert.equal(access.usage.remainingRenders, 14);
    assert.equal(editorAccessState({ phase: "ready", ...access }).title, "14 render slots available", "the rendered notice receives the refreshed server value before upload completion");

    await failUploadJob(uploadingJob.id, "Synthetic multipart abort");
    access = await (await GET(request())).json();
    assert.equal(access.usage.remainingRenders, 15, "aborted upload releases capacity");

    const completedReservation = await reserveRenderCapacity(subscriber);
    const { job: completedJob } = await createUploadJob([{ index: 0, name: "complete.mp4", type: "video/mp4", size: 4 }], null, { subscriberId: subscriber, reservationId: completedReservation });
    await queueJob(completedJob.id, { prompt: "Synthetic upload completion", exportQuality: "standard", sources: [], reference: null });
    const claimed = await claimNextJob("editor-access-test-worker");
    assert.equal(claimed.id, completedJob.id);
    await setJobStatus(completedJob.id, "editor-access-test-worker", "rendering");
    await completeJob(completedJob.id, "editor-access-test-worker", "private/test-output.mp4");
    access = await (await GET(request())).json();
    assert.equal(access.usage.remainingRenders, 14);
    assert.equal(access.usage.successfulRenders, 1);
  } finally { delete process.env.PAID_EDITING_ENFORCEMENT_ENABLED; await db.end(); await closeJobStorePool(); }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { authorizePaidEdit } from "@/lib/paid-editing";
import { closeJobStorePool, completeJob, createUploadJob, getCustomerRenderUsage, getEditingEntitlement, migrateEditJobs, processDodoWebhookEvent, reserveRenderCapacity } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL && process.env.CLIPONAUT_ISOLATED_BILLING_TESTS === "true" ? test : test.skip;
integration("15 consumed renders reject render 16; simulated renewal resets quota and expiry denies access", async () => {
  Object.assign(process.env, { DODO_ENVIRONMENT: "test", CUSTOMER_AUTH_TOKEN_SECRET: "isolated-quota-secret-at-least-thirty-two-characters", DODO_TEST_CLIPONAUT_PRODUCT_ID: "product-quota", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM dodo_webhook_events;");
    const owner = crypto.randomUUID(), token = crypto.randomUUID();
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'quota@example.test','google-quota',now())", [owner]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), owner, hashCustomerToken(token)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,dodo_customer_id,ownership_provenance,status,last_event_at,billing_period_start,billing_period_end) VALUES ('sub-quota','product-quota',$1,'cus-quota','verified','active',now()-interval '1 day',now()-interval '2 days',now()+interval '28 days')", [owner]);
    const consume = async () => {
      const reservationId = await reserveRenderCapacity(owner); assert.ok(reservationId);
      const created = await createUploadJob([], null, { subscriberId: owner, reservationId });
      await db.query("UPDATE edit_jobs SET status='rendering',worker_id='fixture-worker' WHERE id=$1", [created.job.id]);
      assert.ok(await completeJob(created.job.id, "fixture-worker", "fixture/output.mp4"));
    };
    for (let i = 0; i < 15; i++) await consume();
    const request = () => new Request("http://localhost/api/uploads", { headers: { cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });
    assert.equal((await getCustomerRenderUsage(owner)).successfulRenders, 15);
    assert.equal((await getCustomerRenderUsage(owner)).remainingRenders, 0);
    await assert.rejects(() => authorizePaidEdit(request()), error => error.status === 429);
    const start = new Date(Date.now()-3600_000).toISOString(), end = new Date(Date.now()+30*86400_000).toISOString();
    await processDodoWebhookEvent("fixture-renewed-quota", "subscription.renewed", "isolated-renewal-fixture", { subscriptionId: "sub-quota", productId: "product-quota", customerId: "cus-quota", status: "active", occurredAt: new Date().toISOString(), billingStart: start, billingEnd: end, cancellationScheduled: false }, null, true);
    assert.equal((await getCustomerRenderUsage(owner)).remainingRenders, 15);
    assert.equal((await getCustomerRenderUsage(owner)).successfulRenders, 0);
    await consume(); assert.equal((await getCustomerRenderUsage(owner)).remainingRenders, 14);
    assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE state='consumed'")).rows[0].count, 16);
    await db.query("UPDATE dodo_subscriptions SET billing_period_end=now()-interval '1 second' WHERE dodo_subscription_id='sub-quota'");
    assert.equal(await getEditingEntitlement(owner), null); assert.equal(await reserveRenderCapacity(owner), null);
    await assert.rejects(() => authorizePaidEdit(request()), error => error.status === 403);
    await processDodoWebhookEvent("fixture-expired-quota", "subscription.expired", "isolated-expiry-fixture", { subscriptionId: "sub-quota", productId: "product-quota", customerId: "cus-quota", status: "expired", occurredAt: new Date(Date.now()+1000).toISOString(), billingStart: start, billingEnd: new Date(Date.now()-1000).toISOString(), cancellationScheduled: false }, null, true);
    assert.equal((await db.query("SELECT status FROM dodo_subscriptions WHERE dodo_subscription_id='sub-quota'")).rows[0].status, "expired");
    assert.equal(await reserveRenderCapacity(owner), null);
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("Live entitlement and quota reads cannot use Test product subscriptions", async () => {
  Object.assign(process.env, { DODO_ENVIRONMENT: "live", DODO_LIVE_MODE_ENABLED: "true", DODO_TEST_CLIPONAUT_PRODUCT_ID: "product-test", DODO_LIVE_CLIPONAUT_PRODUCT_ID: "product-live", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM dodo_webhook_events;");
    const owner = crypto.randomUUID();
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'mode@example.test','google-mode',now())", [owner]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-test','product-test',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [owner]);
    assert.equal(await getEditingEntitlement(owner), null); assert.equal(await reserveRenderCapacity(owner), null);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-live','product-live',$1,'verified','active',now()-interval '1 day',now()+interval '29 days')", [owner]);
    assert.equal((await getEditingEntitlement(owner)).dodo_subscription_id, "sub-live");
    assert.ok(await reserveRenderCapacity(owner));
    assert.equal((await db.query("SELECT subscription_id FROM render_quota_reservations")).rows[0].subscription_id, "sub-live");
  } finally { await db.end(); await closeJobStorePool(); }
});

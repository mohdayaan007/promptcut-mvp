import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { closeJobStorePool, migrateEditJobs } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;

integration("account usage is session-scoped and derived from the quota ledger", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "account-usage-integration-secret-with-at-least-thirty-two", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner = crypto.randomUUID(); const other = crypto.randomUUID(); const token = "account-usage-session-token";
    for (const [id, email, subject] of [[owner, "owner@example.test", "google-owner"], [other, "other@example.test", "google-other"]]) await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [id, email, subject]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), owner, hashCustomerToken(token)]);
    for (const [id, sub] of [[owner, "sub-owner"], [other, "sub-other"]]) await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ($1,'cliponaut-product',$2,'verified','active',now()-interval '1 day',now()+interval '29 days')", [sub, id]);
    const period = (await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub-owner'")).rows[0];
    for (const state of ["consumed", "reserved"]) await db.query("INSERT INTO render_quota_reservations (id,subscriber_id,subscription_id,period_start,period_end,state) VALUES ($1,$2,'sub-owner',$3,$4,$5)", [crypto.randomUUID(), owner, period.billing_period_start, period.billing_period_end, state]);
    await db.query("INSERT INTO render_quota_reservations (id,subscriber_id,subscription_id,period_start,period_end,state) VALUES ($1,$2,'sub-other',now()-interval '1 day',now()+interval '29 days','consumed')", [crypto.randomUUID(), other]);
    const { GET } = await import("@/app/api/account/usage/route");
    const denied = await GET(new Request("http://localhost/api/account/usage")); assert.equal(denied.status, 401);
    const response = await GET(new Request("http://localhost/api/account/usage", { headers: { cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } }));
    assert.equal(response.status, 200); const usage = await response.json();
    assert.deepEqual({ successful: usage.successfulRenders, reserved: usage.reservedRenders, remaining: usage.remainingRenders, allowance: usage.allowance }, { successful: 1, reserved: 1, remaining: 13, allowance: 15 });
    assert.ok(usage.billingPeriod?.start && usage.billingPeriod?.end);
  } finally { await db.end(); await closeJobStorePool(); }
});

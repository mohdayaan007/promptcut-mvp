import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import { Client } from "pg";
import { createCustomerCheckoutCorrelation, migrateEditJobs, recordCustomerCheckoutSession } from "@/lib/jobs/job-store";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const secret = `whsec_${Buffer.from("dodo-webhook-test-secret-material-over-thirty-two-bytes").toString("base64")}`;
const productId = "pdt_cliponaut_test";
function payload({ type = "subscription.active", status = "active", timestamp = "2026-10-28T08:00:00.000Z" } = {}) { return JSON.stringify({ type, timestamp, business_id: "biz_cliponaut", data: { subscription_id: "sub_1", product_id: productId, brand_id: "brand_cliponaut", status, customer: { customer_id: "cus_1", email: "member@example.test" } } }); }
function paymentPayload(subscriptionId = "sub_bound") { return JSON.stringify({ type: "payment.succeeded", timestamp: "2026-10-28T08:01:00.000Z", business_id: "biz_cliponaut", data: { payment_id: "pay_bound", checkout_session_id: "cs_bound", subscription_id: subscriptionId, subscription_ids: [subscriptionId], brand_id: "brand_cliponaut", metadata: { cliponaut_checkout_ref: "synthetic" } } }); }
function request(body, id) { const timestamp = String(Math.floor(Date.now() / 1000)); const signature = crypto.createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64"); return new Request("http://localhost/api/webhooks/dodo", { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, body }); }

integration("Dodo handler migration, duplicate idempotency, and out-of-order delivery", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "dodo-integration-customer-secret-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "test", DODO_TEST_CLIPONAUT_PRODUCT_ID: productId, DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_WEBHOOK_SECRET: secret, DODO_TEST_BUSINESS_ID: "biz_cliponaut", DODO_TEST_BRAND_ID: "brand_cliponaut" });
  await migrateEditJobs(); const db = new Client({ connectionString: databaseUrl }); await db.connect();
  try {
    await db.query("DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions;"); const { POST } = await import("@/app/api/webhooks/dodo/route");
    const active = payload(); assert.equal((await POST(request(active, "evt_active"))).status, 200); assert.equal((await POST(request(active, "evt_active"))).status, 200);
    const subscriber = crypto.randomUUID(); await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [subscriber, "bound@gmail.com", "bound-google"]);
    const reference = await createCustomerCheckoutCorrelation(subscriber); await recordCustomerCheckoutSession(subscriber, reference, "cs_bound");
    assert.equal((await POST(request(paymentPayload(), "evt_payment_bound"))).status, 200);
    const bound = payload({ timestamp: "2026-10-28T08:02:00.000Z" }).replace('"sub_1"', '"sub_bound"');
    assert.equal((await POST(request(bound, "evt_subscription_bound"))).status, 200);
    assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_bound' ")).rows[0].subscriber_id, subscriber);
    assert.equal((await POST(request(payload({ type: "subscription.cancelled", status: "cancelled", timestamp: "2026-10-28T09:00:00.000Z" }), "evt_cancelled"))).status, 200);
    assert.equal((await POST(request(active, "evt_late"))).status, 200);
    assert.equal((await db.query("SELECT status FROM dodo_subscriptions WHERE dodo_subscription_id='sub_1'")).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM dodo_webhook_events")).rows[0].count, 5);
  } finally { await db.end(); }
});

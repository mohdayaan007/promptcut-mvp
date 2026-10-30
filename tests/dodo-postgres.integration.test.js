import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import { Client } from "pg";
import { closeJobStorePool, confirmCustomerPeriodEndCancellation, createCustomerCheckoutCorrelation, getEditingEntitlement, migrateEditJobs, recordCustomerCheckoutSession, reserveRenderCapacity } from "@/lib/jobs/job-store";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const secret = `whsec_${Buffer.from("dodo-webhook-test-secret-material-over-thirty-two-bytes").toString("base64")}`;
const productId = "pdt_cliponaut_test";
function payload({ type = "subscription.active", status = "active", timestamp = "2026-10-28T08:00:00.000Z" } = {}) { return JSON.stringify({ type, timestamp, business_id: "biz_cliponaut", data: { subscription_id: "sub_1", product_id: productId, brand_id: "brand_cliponaut", status, customer: { customer_id: "cus_1", email: "member@example.test" } } }); }
function paymentPayload(subscriptionId = "sub_bound") { return JSON.stringify({ type: "payment.succeeded", timestamp: "2026-10-28T08:01:00.000Z", business_id: "biz_cliponaut", data: { payment_id: "pay_bound", checkout_session_id: "cs_bound", subscription_id: subscriptionId, subscription_ids: [subscriptionId], brand_id: "brand_cliponaut", metadata: { cliponaut_checkout_ref: "synthetic" } } }); }
function request(body, id) { const timestamp = String(Math.floor(Date.now() / 1000)); const signature = crypto.createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64"); return new Request("http://localhost/api/webhooks/dodo", { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, body }); }
function lifecyclePayload({ type, status, timestamp, billingStart, billingEnd, businessId = "biz_cliponaut", brandId = "brand_cliponaut" }) {
  return JSON.stringify({ type, timestamp, business_id: businessId, data: { subscription_id: "sub_provenance", product_id: productId, brand_id: brandId, status, previous_billing_date: billingStart, next_billing_date: billingEnd, customer: { customer_id: "cus_provenance", email: "provenance@example.test" } } });
}

integration("Dodo handler migration, duplicate idempotency, and out-of-order delivery", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "dodo-integration-customer-secret-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "test", DODO_TEST_CLIPONAUT_PRODUCT_ID: productId, DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_WEBHOOK_SECRET: secret, DODO_TEST_BUSINESS_ID: "biz_cliponaut", DODO_TEST_BRAND_ID: "brand_cliponaut" });
  await migrateEditJobs(); const db = new Client({ connectionString: databaseUrl }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions;"); const { POST } = await import("@/app/api/webhooks/dodo/route");
    const active = payload(); assert.equal((await POST(request(active, "evt_active"))).status, 200); assert.equal((await POST(request(active, "evt_active"))).status, 200);
    const subscriber = crypto.randomUUID(); await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [subscriber, "bound@gmail.com", "bound-google"]);
    const reference = await createCustomerCheckoutCorrelation(subscriber); await recordCustomerCheckoutSession(subscriber, reference, "cs_bound");
    assert.equal((await POST(request(paymentPayload(), "evt_payment_bound"))).status, 200);
    const bound = payload({ timestamp: "2026-10-28T08:02:00.000Z" }).replace('"sub_1"', '"sub_bound"');
    assert.equal((await POST(request(bound, "evt_subscription_bound"))).status, 200);
    assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_bound' ")).rows[0].subscriber_id, subscriber);
    // Historical evidence received without pins stays unverified forever; a
    // later configuration change and duplicate event cannot promote it.
    const historicalPayment = JSON.stringify({ type: "payment.succeeded", timestamp: "2026-10-28T08:03:00.000Z", business_id: "biz_foreign", data: { payment_id: "pay_hist_a", checkout_session_id: "cs_hist_a", subscription_id: "sub_hist_a", subscription_ids: ["sub_hist_a"], brand_id: "brand_foreign" } });
    const historicalSubscription = JSON.stringify({ type: "subscription.active", timestamp: "2026-10-28T08:04:00.000Z", business_id: "biz_foreign", data: { subscription_id: "sub_hist_b", product_id: productId, brand_id: "brand_foreign", status: "active", customer: { customer_id: "cus_hist", email: "bound@gmail.com" } } });
    const intendedPayment = JSON.stringify({ type: "payment.succeeded", timestamp: "2026-10-28T08:05:00.000Z", business_id: "biz_cliponaut", data: { payment_id: "pay_hist_b", checkout_session_id: "cs_hist_b", subscription_id: "sub_hist_b", subscription_ids: ["sub_hist_b"], brand_id: "brand_cliponaut" } });
    const intendedSubscription = JSON.stringify({ type: "subscription.active", timestamp: "2026-10-28T08:06:00.000Z", business_id: "biz_cliponaut", data: { subscription_id: "sub_hist_a", product_id: productId, brand_id: "brand_cliponaut", status: "active", customer: { customer_id: "cus_hist", email: "bound@gmail.com" } } });
    const refA = await createCustomerCheckoutCorrelation(subscriber); await recordCustomerCheckoutSession(subscriber, refA, "cs_hist_a");
    const refB = await createCustomerCheckoutCorrelation(subscriber); await recordCustomerCheckoutSession(subscriber, refB, "cs_hist_b");
    delete process.env.DODO_TEST_BUSINESS_ID; delete process.env.DODO_TEST_BRAND_ID;
    assert.equal((await POST(request(historicalPayment, "evt_hist_payment"))).status, 200);
    assert.equal((await POST(request(historicalSubscription, "evt_hist_subscription"))).status, 200);
    Object.assign(process.env, { DODO_TEST_BUSINESS_ID: "biz_cliponaut", DODO_TEST_BRAND_ID: "brand_cliponaut" });
    assert.equal((await POST(request(intendedSubscription, "evt_hist_intended_subscription"))).status, 200);
    assert.equal((await POST(request(intendedSubscription, "evt_hist_intended_subscription"))).status, 200);
    assert.equal((await POST(request(intendedPayment, "evt_hist_intended_payment"))).status, 200);
    assert.equal((await POST(request(intendedPayment, "evt_hist_intended_payment"))).status, 200);
    assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_hist_a' ")).rows[0].subscriber_id, null);
    assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_hist_b' ")).rows[0].subscriber_id, null);
    assert.equal((await POST(request(payload({ type: "subscription.cancelled", status: "cancelled", timestamp: "2026-10-28T09:00:00.000Z" }), "evt_cancelled"))).status, 200);
    assert.equal((await POST(request(active, "evt_late"))).status, 200);
    assert.equal((await db.query("SELECT status FROM dodo_subscriptions WHERE dodo_subscription_id='sub_1'")).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM dodo_webhook_events")).rows[0].count, 9);
  } finally { await db.end(); }
});

integration("un-pinned lifecycle receipts cannot reactivate or poison a verified subscription", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "dodo-integration-customer-secret-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "test", DODO_TEST_CLIPONAUT_PRODUCT_ID: productId, DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_WEBHOOK_SECRET: secret, DODO_TEST_BUSINESS_ID: "biz_cliponaut", DODO_TEST_BRAND_ID: "brand_cliponaut", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: databaseUrl }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM edit_jobs; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const subscriber = crypto.randomUUID();
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [subscriber, "provenance@example.test", "google-provenance"]);
    const now = Date.now(); const at = (offset) => new Date(now + offset).toISOString();
    const currentStart = at(-60 * 60 * 1000); const currentEnd = at(29 * 24 * 60 * 60 * 1000);
    const activated = lifecyclePayload({ type: "subscription.active", status: "active", timestamp: at(-4_000), billingStart: currentStart, billingEnd: currentEnd });
    const { POST } = await import("@/app/api/webhooks/dodo/route");
    assert.equal((await POST(request(activated, "evt_provenance_active"))).status, 200);
    await db.query("UPDATE dodo_subscriptions SET subscriber_id=$2 WHERE dodo_subscription_id=$1", ["sub_provenance", subscriber]);

    const cancelledAt = at(-3_000);
    const cancelled = lifecyclePayload({ type: "subscription.cancelled", status: "cancelled", timestamp: cancelledAt, billingStart: currentStart, billingEnd: currentEnd });
    assert.equal((await POST(request(cancelled, "evt_provenance_cancelled"))).status, 200);
    assert.equal(await reserveRenderCapacity(subscriber), null);
    const cancelledRow = (await db.query("SELECT status,last_event_at,billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];
    assert.equal(cancelledRow.status, "cancelled");

    delete process.env.DODO_TEST_BUSINESS_ID; delete process.env.DODO_TEST_BRAND_ID;
    const foreign = lifecyclePayload({ type: "subscription.renewed", status: "active", timestamp: at(-2_000), billingStart: at(24 * 60 * 60 * 1000), billingEnd: at(31 * 24 * 60 * 60 * 1000), businessId: "biz_foreign", brandId: "brand_foreign" });
    assert.equal((await POST(request(foreign, "evt_provenance_foreign"))).status, 200);
    const afterForeign = (await db.query("SELECT status,last_event_at,billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];
    assert.equal(afterForeign.status, "cancelled");
    assert.equal(new Date(afterForeign.last_event_at).toISOString(), new Date(cancelledRow.last_event_at).toISOString());
    assert.equal(new Date(afterForeign.billing_period_start).toISOString(), new Date(cancelledRow.billing_period_start).toISOString());
    assert.equal(new Date(afterForeign.billing_period_end).toISOString(), new Date(cancelledRow.billing_period_end).toISOString());
    assert.equal((await db.query("SELECT count(*)::int AS count FROM dodo_webhook_events WHERE event_id='evt_provenance_foreign'")).rows[0].count, 1, "un-pinned receipt remains auditable and idempotent");
    assert.equal(await reserveRenderCapacity(subscriber), null);

    Object.assign(process.env, { DODO_TEST_BUSINESS_ID: "biz_cliponaut", DODO_TEST_BRAND_ID: "brand_cliponaut" });
    const renewedAt = at(-1_000); const renewedStart = at(-30 * 60 * 1000); const renewedEnd = at(30 * 24 * 60 * 60 * 1000);
    const renewed = lifecyclePayload({ type: "subscription.renewed", status: "active", timestamp: renewedAt, billingStart: renewedStart, billingEnd: renewedEnd });
    assert.equal((await POST(request(renewed, "evt_provenance_renewed"))).status, 200);
    assert.ok(await getEditingEntitlement(subscriber));
    assert.ok(await reserveRenderCapacity(subscriber));
    assert.equal((await POST(request(renewed, "evt_provenance_renewed"))).status, 200, "duplicate is recorded idempotently");
    assert.equal((await POST(request(cancelled, "evt_provenance_older_cancelled"))).status, 200, "older event is harmless");
    const finalRow = (await db.query("SELECT status,last_event_at,billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];
    assert.equal(finalRow.status, "active");
    assert.equal(new Date(finalRow.last_event_at).toISOString(), new Date(renewedAt).toISOString());
    assert.equal(new Date(finalRow.billing_period_start).toISOString(), new Date(renewedStart).toISOString());
    assert.equal(new Date(finalRow.billing_period_end).toISOString(), new Date(renewedEnd).toISOString());
  } finally { await db.end(); await closeJobStorePool(); }
});

integration("API-confirmed cancellation survives delayed signed active webhook and terminal cancellation remains authoritative", async () => {
  Object.assign(process.env,{CUSTOMER_AUTH_TOKEN_SECRET:"fix4-secret-at-least-thirty-two-characters",DODO_TEST_MODE_ENABLED:"true",DODO_TEST_API_KEY:"test",DODO_TEST_CLIPONAUT_PRODUCT_ID:productId,DODO_TEST_RETURN_URL:"http://localhost:3000/return",DODO_TEST_WEBHOOK_SECRET:secret,DODO_TEST_BUSINESS_ID:"biz_cliponaut",DODO_TEST_BRAND_ID:"brand_cliponaut"});await migrateEditJobs();const db=new Client({connectionString:databaseUrl});await db.connect();try{await db.query("DELETE FROM render_quota_reservations; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");const subscriber=crypto.randomUUID(),now=Date.now(),at=(n)=>new Date(now+n).toISOString(),start=at(-3600000),end=at(86400000);await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'fix4@test','g4',now())",[subscriber]);const {POST}=await import("@/app/api/webhooks/dodo/route");const active=lifecyclePayload({type:"subscription.active",status:"active",timestamp:at(-5000),billingStart:start,billingEnd:end});assert.equal((await POST(request(active,"fix4-active"))).status,200);await db.query("UPDATE dodo_subscriptions SET subscriber_id=$1 WHERE dodo_subscription_id='sub_provenance'",[subscriber]);assert.ok(await confirmCustomerPeriodEndCancellation(subscriber,"sub_provenance",start,end));const before=(await db.query("SELECT cancellation_confirmed_at,billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];assert.ok(await getEditingEntitlement(subscriber));const delayed=lifecyclePayload({type:"subscription.active",status:"active",timestamp:at(-1000),billingStart:start,billingEnd:end});assert.equal((await POST(request(delayed,"fix4-delayed"))).status,200);let row=(await db.query("SELECT status,cancellation_scheduled,cancellation_confirmed_at,billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];assert.equal(row.cancellation_scheduled,true);assert.equal(new Date(row.cancellation_confirmed_at).toISOString(),new Date(before.cancellation_confirmed_at).toISOString());assert.equal(new Date(row.billing_period_start).toISOString(),new Date(before.billing_period_start).toISOString());assert.equal((await POST(request(delayed,"fix4-delayed"))).status,200);const terminal=lifecyclePayload({type:"subscription.cancelled",status:"cancelled",timestamp:at(1000),billingStart:start,billingEnd:end});assert.equal((await POST(request(terminal,"fix4-terminal"))).status,200);assert.equal(await reserveRenderCapacity(subscriber),null);assert.equal((await POST(request(delayed,"fix4-older-active"))).status,200);row=(await db.query("SELECT status FROM dodo_subscriptions WHERE dodo_subscription_id='sub_provenance'")).rows[0];assert.equal(row.status,"cancelled");}finally{await db.end();await closeJobStorePool();}
});

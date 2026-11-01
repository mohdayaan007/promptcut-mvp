import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { closeJobStorePool, getEditingEntitlement, migrateEditJobs, processDodoWebhookEvent } from "@/lib/jobs/job-store";
import { cliponautPaymentEvent, cliponautSubscriptionEvent } from "@/lib/dodo-test-mode";
import { POST } from "@/app/api/billing/dodo/customer-checkout/route";

const integration = process.env.DATABASE_URL && process.env.CLIPONAUT_ISOLATED_BILLING_TESTS === "true" ? test : test.skip;
async function fixture(run) {
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { CUSTOMER_CHECKOUT_ORIGIN: "https://cliponaut-dodo-test-web-staging.up.railway.app", DODO_ENVIRONMENT: "test", CUSTOMER_AUTH_TOKEN_SECRET: "isolated-launch-secret-at-least-thirty-two-characters", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_CUSTOMER_CHECKOUT_ENABLED: "true", DODO_TEST_API_KEY: "dodo_test_fixture", DODO_TEST_CLIPONAUT_PRODUCT_ID: "product-test", DODO_TEST_BUSINESS_ID: "business-test", DODO_TEST_BRAND_ID: "brand-test", DODO_TEST_RETURN_URL: "http://localhost/account", FOUNDER_CONVERSATIONAL_EDITING_ENABLED: "false", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM dodo_webhook_events;");
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), token = crypto.randomUUID();
    for (const id of [owner, other]) await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [id, `${id}@example.test`, `subject-${id}`]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), owner, hashCustomerToken(token)]);
    const request = (changes = {}) => new Request("https://localhost:8080/api/billing/dodo/customer-checkout", { method: "POST", headers: { origin: "https://cliponaut-dodo-test-web-staging.up.railway.app", cookie: `${CUSTOMER_SESSION_COOKIE}=${token}`, ...changes } });
    await run({ db, owner, other, request });
  } finally {
    globalThis.fetch = originalFetch; await db.end(); await closeJobStorePool();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
}
const checkout = () => Response.json({ session_id: "cks_fixture", checkout_url: "https://test.checkout.dodopayments.com/session/cks_fixture" });

integration("Railway public origin reaches authenticated checkout despite spoofed proxy headers", async () => fixture(async ({ db, owner, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; return checkout(); };
  const response = await POST(request({ host: "foreign.invalid", "x-forwarded-host": "foreign.invalid", "x-forwarded-proto": "http" }));
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal((await db.query("SELECT subscriber_id FROM customer_checkout_correlations")).rows[0].subscriber_id, owner);
}));

integration("origin/configuration/authentication rejection precedes checkout writes and provider calls", async () => fixture(async ({ db, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; return checkout(); };
  for (const origin of ["", "null", "invalid", "https://foreign.invalid", "https://localhost:8080"]) {
    assert.equal((await POST(request({ origin, host: "cliponaut-dodo-test-web-staging.up.railway.app", "x-forwarded-host": "cliponaut-dodo-test-web-staging.up.railway.app", "x-forwarded-proto": "https" }))).status, 403);
  }
  const missing = request(); missing.headers.delete("origin"); assert.equal((await POST(missing)).status, 403);
  assert.equal((await POST(request({ cookie: "" }))).status, 401);
  delete process.env.CUSTOMER_CHECKOUT_ORIGIN;
  assert.equal((await POST(request())).status, 503);
  assert.equal(calls, 0);
  assert.equal((await db.query("SELECT count(*)::int count FROM customer_checkout_correlations")).rows[0].count, 0);
}));

integration("concurrent customer requests create one checkout; later retries resume it without founder access", async () => fixture(async ({ db, owner, request }) => {
  let release, started, calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { calls++; started(); await new Promise(resolve => { release = resolve; }); return checkout(); };
  const first = POST(request()); await ready;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => POST(request())));
  assert.ok(concurrent.every(response => response.status === 409)); assert.equal(calls, 1);
  release(); const created = await first; assert.equal(created.status, 200);
  const reused = await POST(request()); assert.equal(reused.status, 200); assert.deepEqual(await reused.json(), await created.json()); assert.equal(calls, 1);
  const rows = (await db.query("SELECT reference_hash,subscriber_id FROM customer_checkout_correlations")).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].subscriber_id, owner); assert.match(rows[0].reference_hash, /^test:[0-9a-f]{64}$/);
}));

integration("active or past-due canonical subscriptions block another purchase", async () => fixture(async ({ db, owner, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; return checkout(); };
  await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,status,ownership_provenance) VALUES ('sub-existing','product-test',$1,'active','verified')", [owner]);
  assert.equal((await POST(request())).status, 409);
  await db.query("UPDATE dodo_subscriptions SET status='past_due'"); assert.equal((await POST(request())).status, 409);
  assert.equal(calls, 0); assert.equal((await db.query("SELECT count(*)::int count FROM customer_checkout_correlations")).rows[0].count, 0);
}));

integration("uncertain session creation stays blocked; a definite provider rejection can retry", async () => fixture(async ({ db, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("synthetic network interruption"); };
  assert.equal((await POST(request())).status, 503); assert.equal((await POST(request())).status, 409); assert.equal(calls, 1);
  assert.equal((await db.query("SELECT status FROM customer_checkout_correlations")).rows[0].status, "pending");
  await db.query("DELETE FROM customer_checkout_correlations");
  globalThis.fetch = async () => new Response("rejected", { status: 400 }); assert.equal((await POST(request())).status, 503);
  assert.equal((await db.query("SELECT status FROM customer_checkout_correlations")).rows[0].status, "failed");
  globalThis.fetch = async () => checkout(); assert.equal((await POST(request())).status, 200);
}));

integration("legacy, expired and cross-mode pending purchases fail closed", async () => fixture(async ({ db, owner, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; return checkout(); };
  for (const hash of ["legacy-hash", "live:synthetic-hash"]) {
    await db.query("DELETE FROM customer_checkout_correlations");
    await db.query("INSERT INTO customer_checkout_correlations (reference_hash,subscriber_id,checkout_session_id,status,expires_at) VALUES ($1,$2,'cks_other','created',now()+interval '1 day')", [hash, owner]);
    assert.equal((await POST(request())).status, 409);
  }
  await db.query("UPDATE customer_checkout_correlations SET reference_hash='test:synthetic-hash',expires_at=now()-interval '1 day'");
  assert.equal((await POST(request())).status, 409); assert.equal(calls, 0);
}));

integration("authentication, same-origin, feature gate and ownership pins precede provider side effects", async () => fixture(async ({ db, request }) => {
  let calls = 0; globalThis.fetch = async () => { calls++; return checkout(); };
  assert.equal((await POST(request({ cookie: "" }))).status, 401);
  assert.equal((await POST(request({ origin: "https://foreign.invalid" }))).status, 403);
  process.env.DODO_TEST_CUSTOMER_CHECKOUT_ENABLED = "false"; assert.equal((await POST(request())).status, 404);
  process.env.DODO_TEST_CUSTOMER_CHECKOUT_ENABLED = "true"; delete process.env.DODO_TEST_BRAND_ID; assert.equal((await POST(request())).status, 503);
  assert.equal(calls, 0); assert.equal((await db.query("SELECT count(*)::int count FROM customer_checkout_correlations")).rows[0].count, 0);
}));

integration("new mode-tagged checkout preserves provider-proven customer ownership", async () => fixture(async ({ owner, other, request }) => {
  globalThis.fetch = async () => checkout(); assert.equal((await POST(request())).status, 200);
  const config = { productId: "product-test", businessId: "business-test", brandId: "brand-test" };
  const event = { type: "payment.succeeded", business_id: "business-test", timestamp: new Date().toISOString(), data: { brand_id: "brand-test", payment_id: "pay_fixture", checkout_session_id: "cks_fixture", subscription_id: "sub_fixture" } };
  await processDodoWebhookEvent("fixture-payment", event.type, JSON.stringify(event), null, cliponautPaymentEvent(event, config), true);
  const lifecycle = { ...event, type: "subscription.active", data: { brand_id: "brand-test", product_id: "product-test", subscription_id: "sub_fixture", status: "active", previous_billing_date: new Date(Date.now()-60_000).toISOString(), next_billing_date: new Date(Date.now()+86400_000).toISOString(), customer: { customer_id: "cus_fixture" } } };
  await processDodoWebhookEvent("fixture-active", lifecycle.type, JSON.stringify(lifecycle), cliponautSubscriptionEvent(lifecycle, config), null, true);
  assert.equal((await getEditingEntitlement(owner)).subscriber_id, owner); assert.equal(await getEditingEntitlement(other), null);
  // This is isolated protocol simulation, not another provider payment.
}));

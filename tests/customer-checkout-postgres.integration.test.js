import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { grantFounderTestAccess } from "@/lib/founder-test-access";
import { closeJobStorePool, migrateEditJobs } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;

integration("controlled customer checkout requires Google session, stores only a hashed correlation, and ignores client ownership input", async () => {
  Object.assign(process.env, {
    CUSTOMER_AUTH_TOKEN_SECRET: "customer-checkout-integration-secret-with-at-least-thirty-two-characters",
    FOUNDER_CONVERSATIONAL_EDITING_ENABLED: "true", FOUNDER_TEST_ACCESS_SECRET: "founder-checkout-integration-secret-at-least-32",
    DODO_TEST_CUSTOMER_CHECKOUT_ENABLED: "true", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic-key",
    DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", DODO_TEST_RETURN_URL: "http://localhost:3000/account"
  });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const previousFetch = globalThis.fetch;
  try {
    await db.query("DELETE FROM customer_sessions; DELETE FROM customer_checkout_correlations; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const identity = crypto.randomUUID(); const token = "customer-session-token-for-test-only";
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [identity, "google-owner@gmail.com", "google-owner"]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), identity, hashCustomerToken(token)]);
    let providerRequest;
    globalThis.fetch = async (_url, init) => { providerRequest = JSON.parse(init.body); return new Response(JSON.stringify({ session_id: "cs_synthetic_1", checkout_url: "https://checkout.example/cs_synthetic_1" })); };
    const { POST } = await import("@/app/api/billing/dodo/customer-checkout/route");
    const founderCookie = grantFounderTestAccess(process.env.FOUNDER_TEST_ACCESS_SECRET).split(";", 1)[0];
    const cookies = `${founderCookie}; ${CUSTOMER_SESSION_COOKIE}=${token}`;
    const ok = await POST(new Request("http://localhost/api/billing/dodo/customer-checkout", { method: "POST", headers: { cookie: cookies, "content-type": "application/json" }, body: JSON.stringify({ email: "attacker@example.test", productId: "bynd", subscriberId: "other" }) }));
    assert.equal(ok.status, 200); assert.equal(providerRequest.customer.email, "google-owner@gmail.com"); assert.equal(providerRequest.product_cart[0].product_id, "cliponaut-product");
    assert.match(providerRequest.metadata.cliponaut_checkout_ref, /^[A-Za-z0-9_-]{43}$/);
    const stored = await db.query("SELECT checkout_session_id,reference_hash,subscriber_id FROM customer_checkout_correlations");
    assert.equal(stored.rows[0].checkout_session_id, "cs_synthetic_1"); assert.equal(stored.rows[0].subscriber_id, identity); assert.notEqual(stored.rows[0].reference_hash, providerRequest.metadata.cliponaut_checkout_ref);
    const unsigned = await POST(new Request("http://localhost/api/billing/dodo/customer-checkout", { method: "POST", headers: { cookie: founderCookie } }));
    assert.equal(unsigned.status, 401);
  } finally { globalThis.fetch = previousFetch; await db.end(); await closeJobStorePool(); }
});

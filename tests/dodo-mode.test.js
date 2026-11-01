import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { dodoModeConfig, dodoProductId, dodoWebhookSecret, DodoConfigurationError } from "@/lib/dodo-config";
import { cliponautPaymentEvent, cliponautSubscriptionEvent, createDodoTestCheckout, DodoCheckoutError, cancellationRecoveryEnabled, scheduleDodoTestCancellation, verifyDodoWebhook } from "@/lib/dodo-test-mode";
import { paidEditingEnforced } from "@/lib/jobs/job-store";

function environment(mode) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("DODO_")) delete process.env[key];
  Object.assign(process.env, { DODO_ENVIRONMENT: mode, PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15",
    DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "dodo_test_fixture", DODO_TEST_CLIPONAUT_PRODUCT_ID: "product-test", DODO_TEST_BUSINESS_ID: "business-test", DODO_TEST_BRAND_ID: "brand-test", DODO_TEST_RETURN_URL: "http://localhost/account", DODO_TEST_WEBHOOK_SECRET: Buffer.alloc(32, 1).toString("base64"),
    DODO_LIVE_MODE_ENABLED: "true", DODO_LIVE_API_KEY: "dodo_live_fixture", DODO_LIVE_CLIPONAUT_PRODUCT_ID: "product-live", DODO_LIVE_BUSINESS_ID: "business-live", DODO_LIVE_BRAND_ID: "brand-live", DODO_LIVE_RETURN_URL: "https://cliponaut.invalid/account", DODO_LIVE_WEBHOOK_SECRET: Buffer.alloc(32, 2).toString("base64") });
  return () => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); };
}

test("explicit modes use isolated pins, credentials and exact API/checkout hosts", async () => {
  for (const mode of ["test", "live"]) {
    const restore = environment(mode);
    try {
      const config = dodoModeConfig();
      assert.equal(dodoProductId(), `product-${mode}`);
      let request;
      const host = mode === "test" ? "test.checkout.dodopayments.com" : "checkout.dodopayments.com";
      const result = await createDodoTestCheckout({ email: "owner@example.test", fetchImpl: async (url, options) => {
        request = { url, options }; return Response.json({ session_id: "cks_fixture", checkout_url: `https://${host}/session/cks_fixture` });
      } });
      assert.equal(request.url, `https://${mode}.dodopayments.com/checkouts`);
      assert.equal(request.options.headers.Authorization, `Bearer dodo_${mode}_fixture`);
      assert.deepEqual(JSON.parse(request.options.body).product_cart, [{ product_id: `product-${mode}`, quantity: 1 }]);
      assert.equal(result.url, `https://${host}/session/cks_fixture`);
      assert.equal(config.businessId, `business-${mode}`);
      await assert.rejects(createDodoTestCheckout({ email: "owner@example.test", fetchImpl: async () => Response.json({ session_id: "cks_fixture", checkout_url: `https://${mode === "test" ? "checkout.dodopayments.com" : "test.checkout.dodopayments.com"}/session/cks_fixture` }) }), DodoCheckoutError);
    } finally { restore(); }
  }
});

test("Live cannot activate implicitly, fall back to Test, or use a Test key", () => {
  const restore = environment("live");
  try {
    process.env.DODO_LIVE_MODE_ENABLED = "false"; assert.throws(dodoModeConfig, DodoConfigurationError);
    process.env.DODO_LIVE_MODE_ENABLED = "true";
    for (const name of ["API_KEY", "CLIPONAUT_PRODUCT_ID", "BUSINESS_ID", "BRAND_ID", "RETURN_URL", "WEBHOOK_SECRET"]) {
      const key = `DODO_LIVE_${name}`, saved = process.env[key]; delete process.env[key];
      assert.throws(dodoModeConfig, DodoConfigurationError, name); process.env[key] = saved;
    }
    const liveSecret = process.env.DODO_LIVE_WEBHOOK_SECRET;
    process.env.DODO_LIVE_WEBHOOK_SECRET = process.env.DODO_TEST_WEBHOOK_SECRET; assert.throws(dodoModeConfig, DodoConfigurationError);
    process.env.DODO_LIVE_WEBHOOK_SECRET = liveSecret;
    process.env.DODO_LIVE_API_KEY = "dodo_test_fixture"; assert.throws(dodoModeConfig, DodoConfigurationError);
    process.env.DODO_LIVE_API_KEY = "dodo_live_fixture"; process.env.DODO_ENVIRONMENT = "unknown"; assert.throws(dodoModeConfig, DodoConfigurationError);
  } finally { restore(); }
});

test("Live requires enforcement and the frozen 15-render allowance; recovery stays disabled", () => {
  const restore = environment("live");
  try {
    process.env.PAID_EDITING_ENFORCEMENT_ENABLED = "false";
    assert.throws(dodoModeConfig, DodoConfigurationError); assert.throws(paidEditingEnforced, DodoConfigurationError);
    process.env.PAID_EDITING_ENFORCEMENT_ENABLED = "true"; process.env.PAID_RENDER_ALLOWANCE = "16";
    assert.throws(dodoModeConfig, DodoConfigurationError);
    process.env.DODO_TEST_CANCELLATION_RECOVERY_ENABLED = "true"; assert.equal(cancellationRecoveryEnabled(), false);
  } finally { restore(); }
});

test("Live accepts only its selected signing secret and rejects foreign or conflicting identities", () => {
  const restore = environment("live");
  try {
    const config = dodoModeConfig();
    const event = { type: "subscription.active", business_id: "business-live", timestamp: new Date().toISOString(), data: { product_id: "product-live", brand_id: "brand-live", subscription_id: "sub_fixture", status: "active", customer: { customer_id: "cus_fixture" } } };
    const body = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
    const headers = (secret) => new Headers({ "webhook-id": "msg_fixture", "webhook-timestamp": timestamp, "webhook-signature": `v1,${crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(`msg_fixture.${timestamp}.${body}`).digest("base64")}` });
    assert.equal(verifyDodoWebhook({ rawBody: body, headers: headers(dodoWebhookSecret()) }), "msg_fixture");
    assert.throws(() => verifyDodoWebhook({ rawBody: body, headers: headers(process.env.DODO_TEST_WEBHOOK_SECRET) }));
    assert.equal(cliponautSubscriptionEvent(event, config).productId, "product-live");
    for (const [key, value] of [["business_id", "business-test"], ["brand_id", "brand-test"], ["product_id", "product-test"]]) {
      const foreign = structuredClone(event); (key === "business_id" ? foreign : foreign.data)[key] = value;
      assert.throws(() => cliponautSubscriptionEvent(foreign, config));
    }
    const conflicting = structuredClone(event); conflicting.data.business_id = "other";
    assert.throws(() => cliponautSubscriptionEvent(conflicting, config));
    assert.throws(() => cliponautSubscriptionEvent(event, { ...config, brandId: null }));
    const payment = { ...event, type: "payment.succeeded", data: { ...event.data, payment_id: "pay_fixture", checkout_session_id: "cks_fixture", product_cart: [{ product_id: "foreign" }] } };
    assert.throws(() => cliponautPaymentEvent(payment, config));
  } finally { restore(); }
});

test("Live cancellation retains period-end PATCH semantics and never calls Test API", async () => {
  const restore = environment("live");
  try {
    process.env.DODO_LIVE_SUBSCRIPTION_CANCELLATION_ENABLED = "true";
    let request;
    await scheduleDodoTestCancellation({ subscriptionId: "sub_fixture", fetchImpl: async (url, options) => {
      request = { url, options }; return Response.json({ subscription_id: "sub_fixture", product_id: "product-live", brand_id: "brand-live", status: "active", cancel_at_next_billing_date: true, previous_billing_date: "2026-11-01T00:00:00Z", next_billing_date: "2026-12-01T00:00:00Z" });
    } });
    assert.equal(request.url, "https://live.dodopayments.com/subscriptions/sub_fixture");
    assert.equal(request.options.method, "PATCH"); assert.deepEqual(JSON.parse(request.options.body), { cancel_at_next_billing_date: true });
  } finally { restore(); }
});

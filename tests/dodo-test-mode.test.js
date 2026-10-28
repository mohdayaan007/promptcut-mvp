import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import { checkoutRequest, cliponautSubscriptionEvent, dodoTestModeConfig, DodoConfigurationError, DodoWebhookError, verifyDodoWebhook } from "@/lib/dodo-test-mode";

const secret = `whsec_${Buffer.from("dodo-webhook-test-secret-which-is-long-enough").toString("base64")}`;
function headers({ id = "evt_test_1", timestamp = String(Math.floor(Date.now() / 1000)), body = "{}", signingSecret = secret } = {}) {
  const key = Buffer.from(signingSecret.replace(/^whsec_/, ""), "base64");
  const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Headers({ "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` });
}

test("Dodo checkout has exactly one configured Cliponaut subscription item and reduced address friction", () => {
  const request = checkoutRequest({ productId: "pdt_cliponaut_test", email: "Founder@Example.test", returnUrl: "https://test.cliponaut.example/billing/return" });
  assert.deepEqual(request.product_cart, [{ product_id: "pdt_cliponaut_test", quantity: 1 }]);
  assert.equal(request.minimal_address, true);
  assert.equal(request.feature_flags.single_page, true);
  assert.equal(request.customer.email, "founder@example.test");
});

test("checkout configuration rejects absent product ids and disabled test mode", () => {
  const prior = { enabled: process.env.DODO_TEST_MODE_ENABLED, key: process.env.DODO_TEST_API_KEY, product: process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID, url: process.env.DODO_TEST_RETURN_URL };
  try {
    process.env.DODO_TEST_MODE_ENABLED = "true"; process.env.DODO_TEST_API_KEY = "test"; delete process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID; process.env.DODO_TEST_RETURN_URL = "http://localhost:3000/billing/return";
    assert.throws(() => dodoTestModeConfig(), DodoConfigurationError);
    process.env.DODO_TEST_MODE_ENABLED = "false";
    assert.throws(() => dodoTestModeConfig(), DodoConfigurationError);
  } finally { Object.assign(process.env, { DODO_TEST_MODE_ENABLED: prior.enabled, DODO_TEST_API_KEY: prior.key, DODO_TEST_CLIPONAUT_PRODUCT_ID: prior.product, DODO_TEST_RETURN_URL: prior.url }); }
});

test("webhook rejects forged signatures and accepts documented raw-body signatures", () => {
  const body = JSON.stringify({ type: "subscription.active" });
  const now = Date.now();
  const valid = headers({ body, timestamp: String(Math.floor(now / 1000)) });
  assert.equal(verifyDodoWebhook({ headers: valid, rawBody: body, secret, now }), "evt_test_1");
  assert.throws(() => verifyDodoWebhook({ headers: headers({ body, signingSecret: `whsec_${Buffer.from("forged").toString("base64")}` }), rawBody: body, secret, now }), DodoWebhookError);
});

test("only the configured Cliponaut product produces subscription state; BYND and unknown states do not", () => {
  const event = { type: "subscription.active", data: { id: "sub_1", product_id: "cliponaut_product", customer: { email: "member@example.test" } } };
  assert.equal(cliponautSubscriptionEvent(event, "cliponaut_product").status, "active");
  assert.equal(cliponautSubscriptionEvent({ ...event, data: { ...event.data, product_id: "bynd_product" } }, "cliponaut_product"), null);
  assert.equal(cliponautSubscriptionEvent({ ...event, type: "payment.succeeded" }, "cliponaut_product"), null);
  assert.equal(cliponautSubscriptionEvent({ ...event, type: "subscription.cancelled" }, "cliponaut_product").status, "cancelled");
});

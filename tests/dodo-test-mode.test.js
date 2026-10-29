import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import { checkoutRequest, cliponautPaymentEvent, cliponautSubscriptionEvent, createDodoTestCheckout, DodoConfigurationError, DodoWebhookError, parseDodoWebhookEnvelope, verifyDodoWebhook } from "@/lib/dodo-test-mode";

const secret = `whsec_${Buffer.from("dodo-webhook-test-secret-material-over-thirty-two-bytes").toString("base64")}`;
const secret24 = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;
const secret23 = `whsec_${Buffer.alloc(23, 7).toString("base64")}`;
const config = { productId: "pdt_cliponaut_test", businessId: "biz_cliponaut", brandId: "brand_cliponaut" };
const base = () => ({ type: "subscription.active", timestamp: "2026-10-28T08:00:00.000Z", business_id: "biz_cliponaut", data: { subscription_id: "sub_1", product_id: config.productId, brand_id: "brand_cliponaut", status: "active", customer: { customer_id: "cus_1", email: "member@example.test" } } });
function signed(body, signingSecret = secret) { const timestamp = String(Math.floor(Date.now() / 1000)); const value = crypto.createHmac("sha256", Buffer.from(signingSecret.replace(/^whsec_/, ""), "base64")).update(`evt_1.${timestamp}.${body}`).digest("base64"); return new Headers({ "webhook-id": "evt_1", "webhook-timestamp": timestamp, "webhook-signature": `v1,${value}` }); }

test("checkout uses one product, minimal address, and documented session_id/checkout_url", async () => {
  const request = checkoutRequest({ productId: config.productId, email: "Founder@Example.test", returnUrl: "https://test.example/return", metadata: { cliponaut_checkout_ref: "synthetic-reference" } });
  assert.deepEqual(request.product_cart, [{ product_id: config.productId, quantity: 1 }]); assert.equal(request.minimal_address, true); assert.equal(request.feature_flags.single_page, true);
  assert.deepEqual(request.metadata, { cliponaut_checkout_ref: "synthetic-reference" });
  const old = { ...process.env }; Object.assign(process.env, { DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "test", DODO_TEST_CLIPONAUT_PRODUCT_ID: config.productId, DODO_TEST_RETURN_URL: "http://localhost:3000/return" });
  try {
    assert.deepEqual(await createDodoTestCheckout({ email: "a@b.test", fetchImpl: async () => new Response(JSON.stringify({ session_id: "cs_1", checkout_url: "https://checkout.example/cs_1" })) }), { id: "cs_1", url: "https://checkout.example/cs_1" });
    await assert.rejects(createDodoTestCheckout({ email: "a@b.test", fetchImpl: async () => new Response(JSON.stringify({ id: "wrong", url: "https://checkout.example" })) }), DodoConfigurationError);
    await assert.rejects(createDodoTestCheckout({ email: "a@b.test", fetchImpl: async () => new Response(JSON.stringify({ session_id: "cs_1", checkout_url: "https://" })) }), DodoConfigurationError);
  } finally { for (const key of ["DODO_TEST_MODE_ENABLED", "DODO_TEST_API_KEY", "DODO_TEST_CLIPONAUT_PRODUCT_ID", "DODO_TEST_RETURN_URL"]) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; }
});

test("canonical 24-byte and 32-byte webhook secrets verify signatures", () => {
  const body = JSON.stringify(base()); const now = Date.now(); const headers = signed(body);
  assert.equal(verifyDodoWebhook({ headers, rawBody: body, secret, now }), "evt_1");
  const headers24 = signed(body, secret24);
  assert.equal(verifyDodoWebhook({ headers: headers24, rawBody: body, secret: secret24, now }), "evt_1");
});

test("24-byte secret rejects 23-byte, malformed, tampered and forged inputs", () => {
  const body = JSON.stringify(base()); const now = Date.now(); const headers24 = signed(body, secret24);
  for (const bad of ["", "whsec_not-base64!", secret23]) assert.throws(() => verifyDodoWebhook({ headers: headers24, rawBody: body, secret: bad, now }), DodoWebhookError);
  assert.throws(() => verifyDodoWebhook({ headers: headers24, rawBody: `${body} `, secret: secret24, now }), DodoWebhookError);
  assert.throws(() => verifyDodoWebhook({ headers: signed(body, secret), rawBody: body, secret: secret24, now }), DodoWebhookError);
});

test("documented envelope timestamp is required occurrence time", () => {
  assert.equal(parseDodoWebhookEnvelope(base()).occurredAt, "2026-10-28T08:00:00.000Z");
  assert.throws(() => parseDodoWebhookEnvelope({ ...base(), timestamp: undefined }), DodoWebhookError);
  assert.throws(() => parseDodoWebhookEnvelope({ ...base(), business_id: "" }), DodoWebhookError);
});

test("nested customer customer_id is used; email remains unverified evidence", () => {
  assert.equal(cliponautSubscriptionEvent(base(), config).customerId, "cus_1");
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, customer: { id: "cus_1" } } }, config), DodoWebhookError);
});

test("past_due maps explicitly and contradictions are rejected", () => {
  assert.equal(cliponautSubscriptionEvent({ ...base(), type: "subscription.past_due", data: { ...base().data, status: "past_due" } }, config).status, "past_due");
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, status: "cancelled" } }, config), DodoWebhookError);
});

test("malformed subscriptions reject before recording; valid non-subscription events stay supported", () => {
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, subscription_id: "" } }, config), DodoWebhookError);
  assert.equal(cliponautSubscriptionEvent({ type: "payment.succeeded", timestamp: "2026-10-28T08:00:00.000Z", business_id: "biz_cliponaut", data: {} }, config), null);
});

test("BYND, mixed products, business and brand mismatches cannot activate Cliponaut", () => {
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, product_id: "pdt_bynd" } }, config), DodoWebhookError);
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, product_ids: [config.productId, "pdt_bynd"] } }, config), DodoWebhookError);
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), business_id: "biz_bynd" }, config), DodoWebhookError);
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), data: { ...base().data, brand_id: "brand_bynd" } }, config), DodoWebhookError);
  assert.throws(() => cliponautSubscriptionEvent({ ...base(), brand_id: "brand_cliponaut", data: { ...base().data, brand_id: "brand_bynd" } }, config), DodoWebhookError);
});

test("documented failed and on_hold events map safely to past_due", () => {
  for (const [type, status] of [["subscription.failed", "failed"], ["subscription.on_hold", "on_hold"]]) {
    assert.equal(cliponautSubscriptionEvent({ ...base(), type, data: { ...base().data, status } }, config).status, "past_due");
  }
});

test("signed payment evidence requires exact checkout and single subscription identifiers", () => {
  const payment = { type: "payment.succeeded", timestamp: "2026-10-28T08:00:00.000Z", business_id: config.businessId, data: { payment_id: "pay_1", checkout_session_id: "cs_1", subscription_id: "sub_1", subscription_ids: ["sub_1"], brand_id: config.brandId, metadata: { cliponaut_checkout_ref: "untrusted-for-linking" } } };
  assert.deepEqual(cliponautPaymentEvent(payment, config), { paymentId: "pay_1", checkoutSessionId: "cs_1", subscriptionId: "sub_1", occurredAt: "2026-10-28T08:00:00.000Z" });
  for (const data of [{ ...payment.data, checkout_session_id: "" }, { ...payment.data, subscription_ids: ["sub_1", "sub_2"] }, { ...payment.data, brand_id: "brand_bynd" }]) assert.throws(() => cliponautPaymentEvent({ ...payment, data }, config), DodoWebhookError);
});

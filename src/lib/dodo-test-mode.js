import crypto from "crypto";

const TEST_API_BASE = "https://test.dodopayments.com";
const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

export class DodoConfigurationError extends Error {}
export class DodoWebhookError extends Error {}

function configuredUrl(name) {
  const value = process.env[name];
  if (!value) throw new DodoConfigurationError(`${name} is not configured`);
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new DodoConfigurationError(`${name} must be HTTPS (or local HTTP)`);
  return url.toString();
}

export function dodoTestModeConfig() {
  if (process.env.DODO_TEST_MODE_ENABLED !== "true") throw new DodoConfigurationError("Dodo test checkout is disabled");
  const apiKey = process.env.DODO_TEST_API_KEY || "";
  const productId = process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID || "";
  if (!apiKey || !productId) throw new DodoConfigurationError("Dodo test checkout is not configured");
  return { apiKey, productId, returnUrl: configuredUrl("DODO_TEST_RETURN_URL"), businessId: process.env.DODO_TEST_BUSINESS_ID || null, brandId: process.env.DODO_TEST_BRAND_ID || null };
}

export function normalizeEmail(email) {
  if (typeof email !== "string" || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DodoConfigurationError("A valid email address is required");
  return email.trim().toLowerCase();
}

export function checkoutRequest({ productId, email, returnUrl }) {
  return {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: normalizeEmail(email) },
    return_url: returnUrl,
    minimal_address: true,
    feature_flags: { single_page: true }
  };
}

/** Dodo's documented REST endpoint. Network calls are intentionally injectable for tests. */
export async function createDodoTestCheckout({ email, fetchImpl = fetch }) {
  const config = dodoTestModeConfig();
  const response = await fetchImpl(`${TEST_API_BASE}/checkouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(checkoutRequest({ productId: config.productId, email, returnUrl: config.returnUrl }))
  });
  if (!response.ok) throw new DodoConfigurationError("Dodo test checkout could not be created");
  const body = await response.json();
  if (typeof body.session_id !== "string" || !body.session_id || typeof body.checkout_url !== "string" || !/^https:\/\//.test(body.checkout_url)) throw new DodoConfigurationError("Dodo returned an invalid checkout session");
  return { id: body.session_id, url: body.checkout_url };
}

function webhookSecretBytes(secret) {
  const encoded = String(secret || "").replace(/^whsec_/, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new DodoWebhookError("Webhook secret is invalid");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 32 || decoded.toString("base64") !== encoded) throw new DodoWebhookError("Webhook secret is invalid");
  return decoded;
}

/** Standard Webhooks verification used by Dodo: signed-content is id.timestamp.raw-body. */
export function verifyDodoWebhook({ headers, rawBody, secret = process.env.DODO_TEST_WEBHOOK_SECRET, now = Date.now() }) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature") || "";
  if (!id || !/^\d+$/.test(timestamp || "") || !signature) throw new DodoWebhookError("Webhook signature is missing");
  if (Math.abs(now - Number(timestamp) * 1000) > MAX_WEBHOOK_AGE_SECONDS * 1000) throw new DodoWebhookError("Webhook timestamp is outside the allowed window");
  const expected = crypto.createHmac("sha256", webhookSecretBytes(secret)).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const candidates = signature.split(" ").map((part) => part.trim().split(",")).filter(([version]) => version === "v1").map(([, value]) => value).filter(Boolean);
  if (!candidates.some((candidate) => candidate.length === expected.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)))) throw new DodoWebhookError("Webhook signature is invalid");
  return id;
}

export function parseDodoWebhookEnvelope(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.type || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new DodoWebhookError("Webhook envelope is invalid");
  if (typeof event.timestamp !== "string" || !event.timestamp || !Number.isFinite(Date.parse(event.timestamp))) throw new DodoWebhookError("Webhook occurrence timestamp is invalid");
  return { type: event.type, data: event.data, occurredAt: new Date(event.timestamp).toISOString(), businessId: event.business_id || null, brandId: event.brand_id || null };
}

export function cliponautSubscriptionEvent(event, config) {
  const { type, data, occurredAt, businessId, brandId } = parseDodoWebhookEnvelope(event);
  if (!type.startsWith("subscription.")) return null;
  if (config.businessId && businessId !== config.businessId) throw new DodoWebhookError("Webhook business does not match Cliponaut");
  if (config.brandId && brandId !== config.brandId) throw new DodoWebhookError("Webhook brand does not match Cliponaut");
  if (typeof data.product_id !== "string" || data.product_id !== config.productId) throw new DodoWebhookError("Webhook product does not match Cliponaut");
  const secondaryProducts = [...(Array.isArray(data.product_ids) ? data.product_ids : []), ...(Array.isArray(data.items) ? data.items.map((item) => item?.product_id) : [])];
  if (secondaryProducts.some((productId) => productId !== config.productId)) throw new DodoWebhookError("Webhook contains a conflicting product");
  const states = {
    "subscription.active": "active", "subscription.renewed": "active", "subscription.past_due": "past_due",
    "subscription.cancelled": "cancelled", "subscription.expired": "expired"
  };
  if (!states[type]) throw new DodoWebhookError("Unsupported subscription event");
  if (typeof data.subscription_id !== "string" || !data.subscription_id || !data.customer || typeof data.customer !== "object" || typeof data.customer.customer_id !== "string" || !data.customer.customer_id || typeof data.status !== "string") throw new DodoWebhookError("Subscription payload is invalid");
  if (data.status !== states[type]) throw new DodoWebhookError("Subscription event conflicts with current status");
  return { subscriptionId: data.subscription_id, status: states[type], productId: config.productId, customerId: data.customer.customer_id, email: typeof data.customer.email === "string" ? normalizeEmail(data.customer.email) : null, occurredAt };
}

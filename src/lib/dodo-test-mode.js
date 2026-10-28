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
  return { apiKey, productId, returnUrl: configuredUrl("DODO_TEST_RETURN_URL") };
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
  const checkoutUrl = body.checkout_url || body.url;
  if (typeof checkoutUrl !== "string" || !/^https:\/\//.test(checkoutUrl)) throw new DodoConfigurationError("Dodo returned an invalid checkout URL");
  return { id: body.checkout_id || body.id || null, url: checkoutUrl };
}

function webhookSecretBytes(secret) {
  const encoded = String(secret || "").replace(/^whsec_/, "");
  if (!encoded) throw new DodoWebhookError("Webhook secret is not configured");
  try { return Buffer.from(encoded, "base64"); } catch { throw new DodoWebhookError("Webhook secret is invalid"); }
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

export function cliponautSubscriptionEvent(event, productId) {
  const data = event?.data || {};
  const products = [data.product_id, data.product?.product_id, data.product?.id, ...(Array.isArray(data.product_ids) ? data.product_ids : []), ...(Array.isArray(data.items) ? data.items.map((item) => item.product_id) : [])].filter(Boolean);
  if (!products.includes(productId)) return null;
  const type = event.type || event.event_type;
  const states = {
    "subscription.active": "active", "subscription.renewed": "active", "subscription.on_hold": "past_due",
    "subscription.failed": "past_due", "subscription.cancelled": "cancelled", "subscription.expired": "expired"
  };
  if (!states[type]) return null;
  const subscriptionId = data.subscription_id || data.id;
  if (typeof subscriptionId !== "string" || !subscriptionId) return null;
  const email = data.customer?.email || data.customer_email || null;
  const occurredAt = event.created_at || event.createdAt || data.updated_at || data.updatedAt || new Date().toISOString();
  return { subscriptionId, status: states[type], productId, customerId: data.customer_id || data.customer?.id || null, email: email ? normalizeEmail(email) : null, occurredAt };
}

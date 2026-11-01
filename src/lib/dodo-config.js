/** Server-only billing configuration. Selecting Live never falls back to Test. */
export class DodoConfigurationError extends Error {}

export function dodoMode() {
  const mode = process.env.DODO_ENVIRONMENT || "test";
  if (!["test", "live"].includes(mode)) throw new DodoConfigurationError("Dodo environment is invalid");
  if (mode === "live" && process.env.DODO_LIVE_MODE_ENABLED !== "true") throw new DodoConfigurationError("Dodo Live Mode is disabled");
  return mode;
}

function value(name) { return process.env[`DODO_${dodoMode().toUpperCase()}_${name}`] || ""; }
export function dodoProductId() { return value("CLIPONAUT_PRODUCT_ID"); }
export function dodoWebhookSecret() { return value("WEBHOOK_SECRET"); }
export function customerCheckoutEnabled() { return value("CUSTOMER_CHECKOUT_ENABLED") === "true"; }
export function periodEndCancellationConfigured() { return value("SUBSCRIPTION_CANCELLATION_ENABLED") === "true"; }

export function dodoModeConfig() {
  const mode = dodoMode();
  if (value("MODE_ENABLED") !== "true") throw new DodoConfigurationError("Dodo billing is disabled");
  const apiKey = value("API_KEY"), productId = dodoProductId();
  const businessId = value("BUSINESS_ID") || null, brandId = value("BRAND_ID") || null;
  if (!apiKey || !productId) throw new DodoConfigurationError("Dodo billing is not configured");
  if ((mode === "test" && apiKey.startsWith("dodo_live_")) || (mode === "live" && !apiKey.startsWith("dodo_live_"))) throw new DodoConfigurationError("Dodo credential mode does not match");
  if (mode === "live" && (!businessId || !brandId)) throw new DodoConfigurationError("Dodo Live identity pins are not configured");
  if (mode === "live" && (!value("WEBHOOK_SECRET") || value("WEBHOOK_SECRET") === process.env.DODO_TEST_WEBHOOK_SECRET)) throw new DodoConfigurationError("An independent Live webhook secret is required");
  if (mode === "live" && (process.env.PAID_EDITING_ENFORCEMENT_ENABLED !== "true" || Number(process.env.PAID_RENDER_ALLOWANCE || 15) !== 15)) throw new DodoConfigurationError("Live billing requires paid enforcement and allowance 15");
  let returnUrl;
  try { returnUrl = new URL(value("RETURN_URL")); } catch { throw new DodoConfigurationError("Dodo return URL is not configured"); }
  if (returnUrl.username || returnUrl.password || (returnUrl.protocol !== "https:" && !(mode === "test" && returnUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(returnUrl.hostname)))) throw new DodoConfigurationError("Dodo return URL must be HTTPS");
  return { mode, apiKey, productId, businessId, brandId, returnUrl: returnUrl.toString(),
    apiBase: `https://${mode === "live" ? "live" : "test"}.dodopayments.com`,
    checkoutHost: mode === "live" ? "checkout.dodopayments.com" : "test.checkout.dodopayments.com" };
}

export function checkoutSessionUrl(sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new DodoConfigurationError("Dodo checkout identity is invalid");
  return `https://${dodoModeConfig().checkoutHost}/session/${sessionId}`;
}

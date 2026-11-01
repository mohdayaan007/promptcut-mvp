import { PublicRequestError } from "@/lib/jobs/http";

/** Sign-in and checkout share the operator's sole browser origin, never proxy headers. */
export function requireCustomerCheckoutOrigin(req, {
  requestMessage = "Invalid checkout request.",
  configMessage = "Checkout origin is not configured.",
} = {}) {
  const configured = process.env.CUSTOMER_CHECKOUT_ORIGIN;
  let origin;
  try { origin = new URL(configured); } catch { /* Fail closed below. */ }
  if (!origin || origin.protocol !== "https:" || origin.username || origin.password || configured !== origin.origin) {
    throw new PublicRequestError(configMessage, 503);
  }
  if (req.headers.get("origin") !== configured) {
    throw new PublicRequestError(requestMessage, 403);
  }
}

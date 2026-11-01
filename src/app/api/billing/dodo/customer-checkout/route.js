import { customerSessionToken } from "@/lib/customer-auth";
import { createDodoTestCheckout, customerOwnershipProvenanceConfigured, DodoCheckoutError, DodoConfigurationError } from "@/lib/dodo-test-mode";
import { checkoutSessionUrl, customerCheckoutEnabled, dodoModeConfig } from "@/lib/dodo-config";
import { CustomerCheckoutConflict, reserveCustomerCheckout, failCustomerCheckoutCorrelation, getCustomerSession, recordCustomerCheckoutSession } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";

export const runtime = "nodejs";

/** Authenticated, mode-gated checkout: caller data never selects product or owner. */
export async function POST(req) {
  try {
    if (!customerCheckoutEnabled()) throw new PublicRequestError("Checkout is not available.", 404);
    if (req.headers.get("origin") !== new URL(req.url).origin) throw new PublicRequestError("Invalid checkout request.", 403);
    const customer = await getCustomerSession(customerSessionToken(req));
    if (!customer) throw new PublicRequestError("Sign-in is required.", 401);
    if (!customerOwnershipProvenanceConfigured(dodoModeConfig())) throw new DodoConfigurationError("Checkout identity pins are not configured");
    const pending = await reserveCustomerCheckout(customer.subscriber_id);
    if (pending.checkoutId) return Response.json({ checkoutUrl: checkoutSessionUrl(pending.checkoutId), checkoutId: pending.checkoutId }, { headers: { "Cache-Control": "no-store" } });
    const { reference } = pending;
    try {
      const checkout = await createDodoTestCheckout({ email: customer.email, metadata: { cliponaut_checkout_ref: reference } });
      await recordCustomerCheckoutSession(customer.subscriber_id, reference, checkout.id);
      return Response.json({ checkoutUrl: checkout.url, checkoutId: checkout.id }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      // A timeout, invalid provider response, or local recording failure may
      // occur after a session was created. Never release that gate blindly.
      if (error instanceof DodoCheckoutError && !error.uncertain) await failCustomerCheckoutCorrelation(customer.subscriber_id, reference);
      throw error;
    }
  } catch (error) {
    if (error instanceof CustomerCheckoutConflict) return jsonError(new PublicRequestError(error.message, 409));
    if (error instanceof DodoConfigurationError) return jsonError(new PublicRequestError("Checkout is unavailable or awaiting verification. Check your account before retrying.", 503));
    return jsonError(error);
  }
}

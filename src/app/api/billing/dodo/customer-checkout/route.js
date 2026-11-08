import { customerSessionToken } from "@/lib/customer-auth";
import { createDodoTestCheckout, customerOwnershipProvenanceConfigured, DodoCheckoutError, DodoConfigurationError } from "@/lib/dodo-test-mode";
import { customerCheckoutEnabled, dodoModeConfig } from "@/lib/dodo-config";
import { CustomerCheckoutConflict, CustomerCheckoutReconciliationRequired, reserveCustomerCheckout, failCustomerCheckoutCorrelation, getCustomerSession, recordCustomerCheckoutSession } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { requireCustomerCheckoutOrigin } from "@/lib/checkout-origin";
import { authorizeFounderLiveCheckout, founderLiveCheckoutConfigured, founderLiveCheckoutRequested } from "@/lib/founder-live-checkout";

export const runtime = "nodejs";

/** Authenticated, mode-gated checkout: caller data never selects product or owner. */
export async function POST(req) {
  try {
    const founderOnly = founderLiveCheckoutRequested();
    if (founderOnly ? !founderLiveCheckoutConfigured() : !customerCheckoutEnabled()) throw new PublicRequestError("Checkout is not available.", 404);
    requireCustomerCheckoutOrigin(req);
    const customer = await getCustomerSession(customerSessionToken(req));
    if (!customer) throw new PublicRequestError("Sign-in is required.", 401);
    if (founderOnly && !await authorizeFounderLiveCheckout(customer.subscriber_id)) throw new PublicRequestError("Checkout is not available.", 403);
    if (!customerOwnershipProvenanceConfigured(dodoModeConfig())) throw new DodoConfigurationError("Checkout identity pins are not configured");
    const pending = await reserveCustomerCheckout(customer.subscriber_id);
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
    if (error instanceof CustomerCheckoutReconciliationRequired) return Response.json({ error: error.message, code: "checkout_reconciliation_required" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    if (error instanceof CustomerCheckoutConflict) return jsonError(new PublicRequestError(error.message, 409));
    if (error instanceof DodoConfigurationError) return jsonError(new PublicRequestError("Checkout is unavailable or awaiting verification. Check your account before retrying.", 503));
    return jsonError(error);
  }
}

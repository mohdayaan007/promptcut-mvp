import { customerSessionToken } from "@/lib/customer-auth";
import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { createDodoTestCheckout, DodoConfigurationError } from "@/lib/dodo-test-mode";
import { createCustomerCheckoutCorrelation, failCustomerCheckoutCorrelation, getCustomerSession, recordCustomerCheckoutSession } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";

export const runtime = "nodejs";

function enabled() { return process.env.DODO_TEST_CUSTOMER_CHECKOUT_ENABLED === "true"; }

/** Controlled-only customer checkout: caller data never selects product or owner. */
export async function POST(req) {
  try {
    if (!enabled() || !hasFounderTestAccess(req)) throw new PublicRequestError("Checkout is not available.", 404);
    const customer = await getCustomerSession(customerSessionToken(req));
    if (!customer) throw new PublicRequestError("Sign-in is required.", 401);
    const reference = await createCustomerCheckoutCorrelation(customer.subscriber_id);
    try {
      const checkout = await createDodoTestCheckout({ email: customer.email, metadata: { cliponaut_checkout_ref: reference } });
      await recordCustomerCheckoutSession(customer.subscriber_id, reference, checkout.id);
      return Response.json({ checkoutUrl: checkout.url, checkoutId: checkout.id }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      await failCustomerCheckoutCorrelation(customer.subscriber_id, reference);
      throw error;
    }
  } catch (error) {
    if (error instanceof DodoConfigurationError) return jsonError(new PublicRequestError("Test checkout is not configured.", 503));
    return jsonError(error);
  }
}

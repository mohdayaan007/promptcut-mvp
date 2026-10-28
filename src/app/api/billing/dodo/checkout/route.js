import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { createDodoTestCheckout, DodoConfigurationError } from "@/lib/dodo-test-mode";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    if (!hasFounderTestAccess(req)) throw new PublicRequestError("Checkout is not available.", 404);
    const { email } = await req.json();
    const checkout = await createDodoTestCheckout({ email });
    return Response.json({ checkoutUrl: checkout.url, checkoutId: checkout.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DodoConfigurationError) return jsonError(new PublicRequestError("Test checkout is not configured.", 503));
    return jsonError(error);
  }
}

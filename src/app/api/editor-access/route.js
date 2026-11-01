import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerRenderUsage, getCustomerSession, getCustomerSubscriptionStatus, getEditingEntitlement, paidEditingEnforced } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

/** Presentation-only snapshot; upload and conversation routes remain authoritative. */
export async function GET(req) {
  if (!paidEditingEnforced()) return Response.json({ enforced: false }, { headers: { "Cache-Control": "no-store" } });
  const customer = await getCustomerSession(customerSessionToken(req));
  if (!customer) return Response.json({ enforced: true, signedIn: false, subscriptionStatus: "not_subscribed", usage: null }, { headers: { "Cache-Control": "no-store" } });
  const [subscriptionStatus, usage, entitlement] = await Promise.all([
    getCustomerSubscriptionStatus(customer.subscriber_id), getCustomerRenderUsage(customer.subscriber_id), getEditingEntitlement(customer.subscriber_id)
  ]);
  return Response.json({ enforced: true, signedIn: true, subscriptionStatus, usage, eligible: Boolean(entitlement && usage.remainingRenders > 0) }, { headers: { "Cache-Control": "no-store" } });
}

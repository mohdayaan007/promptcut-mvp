import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerSession, getCustomerSubscriptionStatus } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  const session = await getCustomerSession(customerSessionToken(req));
  const subscriptionStatus = session ? await getCustomerSubscriptionStatus(session.subscriber_id) : "not_subscribed";
  return Response.json({ signedIn: Boolean(session), email: session?.email || null, subscriptionStatus }, { headers: { "Cache-Control": "no-store" } });
}

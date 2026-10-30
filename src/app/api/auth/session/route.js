import { customerSessionToken } from "@/lib/customer-auth";
import { periodEndCancellationEnabled } from "@/lib/dodo-test-mode";
import { getCustomerCancellationManagementState, getCustomerSession, getCustomerSubscriptionStatus } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  const session = await getCustomerSession(customerSessionToken(req));
  const subscriptionStatus = session ? await getCustomerSubscriptionStatus(session.subscriber_id) : "not_subscribed";
  const cancellation = session && periodEndCancellationEnabled()
    ? await getCustomerCancellationManagementState(session.subscriber_id)
    : { state: "none", periodEnd: null };
  return Response.json({ signedIn: Boolean(session), email: session?.email || null, subscriptionStatus,
    cancellation: { ...cancellation, enabled: Boolean(session) && periodEndCancellationEnabled() } }, { headers: { "Cache-Control": "no-store" } });
}

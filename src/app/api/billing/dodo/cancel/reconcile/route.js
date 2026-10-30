import { customerSessionToken } from "@/lib/customer-auth";
import { DodoCancellationError, dodoTestCancellationConfig, getDodoTestCancellationState, periodEndCancellationEnabled } from "@/lib/dodo-test-mode";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { confirmCustomerPeriodEndCancellation, getCustomerCancellableSubscription, getCustomerSession } from "@/lib/jobs/job-store";

export const runtime = "nodejs";
export function createCancellationReconciliationHandler({ retrieve = getDodoTestCancellationState } = {}) {
  return async function POST(req) {
    try {
      if (req.headers.get("origin") !== new URL(req.url).origin) throw new PublicRequestError("Invalid cancellation request", 403);
      if (!periodEndCancellationEnabled()) throw new PublicRequestError("Subscription cancellation is unavailable in this environment.", 503);
      dodoTestCancellationConfig();
      const customer = await getCustomerSession(customerSessionToken(req)); if (!customer) throw new PublicRequestError("Sign in is required.", 401);
      const subscription = await getCustomerCancellableSubscription(customer.subscriber_id); if (!subscription) throw new PublicRequestError("No verified active Cliponaut subscription can be reconciled.", 404);
      if (subscription.cancellation_scheduled) return Response.json({ scheduled: true, periodEnd: new Date(subscription.billing_period_end).toISOString() });
      if (!subscription.cancellation_request_started_at) return Response.json({ scheduled: false, pending: false });
      const provider = await retrieve({ subscriptionId: subscription.dodo_subscription_id });
      if (!provider.scheduled) return Response.json({ scheduled: false, pending: true, reviewRequired: true });
      const confirmed = await confirmCustomerPeriodEndCancellation(customer.subscriber_id, provider.subscriptionId, provider.billingStart, provider.billingEnd);
      if (!confirmed) return Response.json({ scheduled: false, pending: true, reviewRequired: true });
      return Response.json({ scheduled: true, periodEnd: new Date(confirmed.billing_period_end).toISOString() });
    } catch (error) { if (error instanceof DodoCancellationError) return jsonError(new PublicRequestError("Cancellation status requires review.", 503)); return jsonError(error); }
  };
}
export const POST = createCancellationReconciliationHandler();

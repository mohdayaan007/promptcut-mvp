import { customerSessionToken } from "@/lib/customer-auth";
import { DodoCancellationError, DodoConfigurationError, dodoTestCancellationConfig, periodEndCancellationEnabled, scheduleDodoTestCancellation } from "@/lib/dodo-test-mode";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { beginCustomerPeriodEndCancellation, clearCustomerPeriodEndCancellationRequest, confirmCustomerPeriodEndCancellation, getCustomerCancellableSubscription, getCustomerSession } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

function requireSameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin) throw new PublicRequestError("Invalid cancellation request", 403);
}

export function createCancellationHandler({ schedule = scheduleDodoTestCancellation } = {}) {
  return async function POST(req) {
  let subscription;
  try {
    requireSameOrigin(req);
    if (!periodEndCancellationEnabled()) throw new PublicRequestError("Subscription cancellation is unavailable in this environment.", 503);
    // Configuration errors are proven pre-dispatch failures. Validate before
    // acquiring the durable gate so a corrected configuration can be retried.
    dodoTestCancellationConfig();
    const customer = await getCustomerSession(customerSessionToken(req));
    if (!customer) throw new PublicRequestError("Sign in is required.", 401);
    subscription = await getCustomerCancellableSubscription(customer.subscriber_id);
    if (!subscription) throw new PublicRequestError("No verified active Cliponaut subscription can be cancelled.", 404);
    if (subscription.cancellation_scheduled) return Response.json({ scheduled: true, periodEnd: new Date(subscription.billing_period_end).toISOString(), duplicate: true });
    if (!await beginCustomerPeriodEndCancellation(customer.subscriber_id, subscription.dodo_subscription_id)) return Response.json({ scheduled: false, pending: true }, { status: 202 });
    const provider = await schedule({ subscriptionId: subscription.dodo_subscription_id });
    const confirmed = await confirmCustomerPeriodEndCancellation(customer.subscriber_id, provider.subscriptionId, provider.billingStart, provider.billingEnd);
    if (!confirmed) throw new DodoCancellationError("Cancellation was confirmed by Dodo but could not be safely matched to the current verified period.", { uncertain: true });
    return Response.json({ scheduled: true, periodEnd: new Date(confirmed.billing_period_end).toISOString() });
  } catch (error) {
    if (error instanceof DodoConfigurationError) return jsonError(new PublicRequestError("Subscription cancellation is unavailable in this environment.", 503));
    if (error instanceof DodoCancellationError) { if (!error.uncertain) await clearCustomerPeriodEndCancellationRequest(subscription?.dodo_subscription_id).catch(() => {}); return jsonError(new PublicRequestError(error.message, error.uncertain ? 503 : 502)); }
    return jsonError(error);
  }
  };
}

export const POST = createCancellationHandler();

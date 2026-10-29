import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerSession, getEditingEntitlement, getAuthorizedSubscriberJob, getAuthorizedSubscriberSession, paidEditingEnforced, reserveRenderCapacity } from "@/lib/jobs/job-store";
import { PublicRequestError } from "@/lib/jobs/http";

/** Disabled by default; when enabled all customer work is server-authorized. */
export async function authorizePaidEdit(request) {
  if (!paidEditingEnforced()) return { enforced: false, subscriberId: null, reservationId: null };
  const customer = await getCustomerSession(customerSessionToken(request));
  if (!customer) throw new PublicRequestError("Sign in with Google to edit.", 401);
  if (!await getEditingEntitlement(customer.subscriber_id)) throw new PublicRequestError("An active Cliponaut subscription is required.", 403);
  const reservationId = await reserveRenderCapacity(customer.subscriber_id);
  if (!reservationId) throw new PublicRequestError("No renders are currently available for this billing period.", 429);
  return { enforced: true, subscriberId: customer.subscriber_id, reservationId };
}
export async function authorizePaidJob(request, id, token, { requireCurrentEntitlement = true } = {}) {
  if (!paidEditingEnforced()) return null;
  const customer = await getCustomerSession(customerSessionToken(request));
  if (!customer) throw new PublicRequestError("Sign in with Google to access this edit.", 401);
  if (requireCurrentEntitlement && !await getEditingEntitlement(customer.subscriber_id)) throw new PublicRequestError("An active Cliponaut subscription is required.", 403);
  const job = await getAuthorizedSubscriberJob(id, token, customer.subscriber_id);
  if (!job) throw new PublicRequestError("Edit job was not found", 404);
  return job;
}
export async function authorizePaidSession(request, id, token, { requireCurrentEntitlement = true } = {}) {
  if (!paidEditingEnforced()) return null;
  const customer = await getCustomerSession(customerSessionToken(request));
  if (!customer) throw new PublicRequestError("Sign in with Google to access this edit.", 401);
  if (requireCurrentEntitlement && !await getEditingEntitlement(customer.subscriber_id)) throw new PublicRequestError("An active Cliponaut subscription is required.", 403);
  const session = await getAuthorizedSubscriberSession(id, token, customer.subscriber_id);
  if (!session) throw new PublicRequestError("Editing session was not found", 404);
  return { session, subscriberId: customer.subscriber_id };
}

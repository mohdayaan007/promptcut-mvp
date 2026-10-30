export const subscriptionCopy = {
  not_subscribed: { title: "No Cliponaut Pro subscription", detail: "Your account is ready when founder-approved checkout becomes available." },
  pending_verification: { title: "Checkout pending verification", detail: "We are waiting for provider-confirmed subscription evidence." },
  active: { title: "Provider subscription active", detail: "We still verify current billing-period evidence before enabling a new render." },
  cancellation_scheduled: { title: "Cancellation scheduled", detail: "Renewal will stop at the verified end of your current billing period. Your existing Pro access remains available until then." },
  past_due: { title: "Subscription needs attention", detail: "New paid renders are paused while the subscription is past due." },
  cancelled: { title: "Subscription cancelled", detail: "Completed work remains available, but new paid renders are unavailable." },
  expired: { title: "Subscription expired", detail: "New paid renders are unavailable until a verified subscription is active." }
};

export function accountState(status) { return subscriptionCopy[status] || subscriptionCopy.not_subscribed; }
export function billingPeriodState(usage, now = Date.now()) {
  if (!usage?.billingPeriod || usage.successfulRenders === null || usage.reservedRenders === null) return { available: false, timing: "unavailable" };
  const start = Date.parse(usage.billingPeriod.start); const end = Date.parse(usage.billingPeriod.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return { available: false, timing: "unavailable" };
  if (start > now) return { available: true, timing: "future", ...usage };
  if (end <= now) return { available: true, timing: "historical", ...usage };
  return { available: true, timing: "current", ...usage };
}
export function usageState(usage, now) { return billingPeriodState(usage, now); }
export function editingReadiness(status, usage, now) {
  if (!["active", "cancellation_scheduled"].includes(status)) return { title: "New renders unavailable", detail: "A current active subscription is required before another paid render can start." };
  const period = billingPeriodState(usage, now);
  if (!period.available) return { title: "Editing availability unavailable", detail: "We cannot verify a current billing period yet, so new renders remain unavailable." };
  if (period.timing !== "current") return { title: "No current verified billing period", detail: period.timing === "future" ? "Your verified billing period has not started yet." : "Your verified billing period has ended." };
  if (period.remainingRenders <= 0) return { title: "Render allowance used", detail: "No render slots remain in this verified billing period." };
  return { title: "New renders available", detail: `${period.remainingRenders} render ${period.remainingRenders === 1 ? "slot remains" : "slots remain"} in this verified billing period.` };
}
export async function performLogout(fetchImpl = fetch) {
  const response = await fetchImpl("/api/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("We could not sign you out. Please try again.");
  return true;
}

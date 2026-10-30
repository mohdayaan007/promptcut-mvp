export const subscriptionCopy = {
  not_subscribed: { title: "No Cliponaut Pro subscription", detail: "Your account is ready when founder-approved checkout becomes available." },
  pending_verification: { title: "Checkout pending verification", detail: "We are waiting for provider-confirmed subscription evidence." },
  active: { title: "Cliponaut Pro is active", detail: "Your verified subscription is ready for eligible editing." },
  past_due: { title: "Subscription needs attention", detail: "New paid renders are paused while the subscription is past due." },
  cancelled: { title: "Subscription cancelled", detail: "Completed work remains available, but new paid renders are unavailable." },
  expired: { title: "Subscription expired", detail: "New paid renders are unavailable until a verified subscription is active." }
};

export function accountState(status) { return subscriptionCopy[status] || subscriptionCopy.not_subscribed; }
export function usageState(usage) {
  if (!usage?.billingPeriod || usage.successfulRenders === null || usage.reservedRenders === null) return { available: false };
  return { available: true, ...usage };
}

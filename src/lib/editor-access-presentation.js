const account = "/account";
const pricing = "/pricing";

export function editorAccessState(access) {
  if (!access || access.phase === "loading") return { blocking: false, tone: "loading", title: "Checking editing access…", detail: "", action: null };
  if (access.phase === "error") return { blocking: false, tone: "error", title: "Couldn’t verify editing access", detail: "Your next request will still be checked securely. Retry before starting a new render.", action: "retry" };
  if (!access.enforced) return { blocking: false, tone: "off", title: "", detail: "", action: null };
  if (!access.signedIn) return { blocking: true, tone: "blocked", title: "Sign in to edit", detail: "Sign in with Google to use Cliponaut Pro.", href: account };
  if (access.subscriptionStatus === "pending_verification") return { blocking: true, tone: "blocked", title: "Checkout pending verification", detail: "Wait for provider-confirmed subscription evidence before starting a render.", href: account };
  if (["past_due", "cancelled", "expired"].includes(access.subscriptionStatus)) return { blocking: true, tone: "blocked", title: "New renders unavailable", detail: "Your subscription does not currently permit a new paid render. Completed work remains available.", href: account };
  if (!["active", "cancellation_scheduled"].includes(access.subscriptionStatus)) return { blocking: true, tone: "blocked", title: "Cliponaut Pro is required", detail: "A verified subscription is required before starting a render.", href: pricing };
  if (!access.usage?.billingPeriod || access.usage.remainingRenders === null) return { blocking: true, tone: "blocked", title: "Editing availability unavailable", detail: "A current verified billing period is required before starting a render.", href: account };
  if (access.usage.remainingRenders <= 0) return { blocking: true, tone: "blocked", title: "Render allowance used", detail: "No render slots remain in this billing period. Completed work remains available.", href: account };
  return { blocking: false, tone: "ready", title: `${access.usage.remainingRenders} render ${access.usage.remainingRenders === 1 ? "slot" : "slots"} available`, detail: "Allowance is confirmed by the server and updates as renders progress.", action: null };
}

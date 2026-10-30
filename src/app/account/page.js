"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckoutButton } from "@/components/cliponaut/CheckoutButton";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";
import { accountState, billingPeriodState, editingReadiness, performLogout } from "@/lib/account-presentation";
import { createGoogleSignInCoordinator, loadGoogleIdentityScript } from "@/lib/google-sign-in-client";

const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
function dateRange(period) { return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(period.start))} – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(period.end))}`; }

function UsageCard({ usage, phase }) {
  const current = billingPeriodState(usage);
  if (phase === "loading") return <section className="cliponaut-account-card" aria-busy="true"><p className="cliponaut-marketing-eyebrow">Render allowance</p><h2>Loading usage…</h2></section>;
  if (!current.available) return <section className="cliponaut-account-card"><p className="cliponaut-marketing-eyebrow">Render allowance</p><h2>Usage unavailable</h2><p>Verified billing-period information is needed before we can show usage safely.</p></section>;
  const periodLabel = current.timing === "current" ? "This billing period" : current.timing === "future" ? "Upcoming verified period" : "Previous verified period";
  return <section className="cliponaut-account-card cliponaut-usage-card"><div><p className="cliponaut-marketing-eyebrow">{periodLabel}</p><h2>{dateRange(current.billingPeriod)}</h2></div><div className="cliponaut-usage-grid"><p><strong>{current.successfulRenders}</strong><span>Successful renders</span></p><p><strong>{current.reservedRenders}</strong><span>Reserved / in progress</span></p><p><strong>{current.timing === "current" ? current.remainingRenders : "—"}</strong><span>Available slots</span></p></div><p className="cliponaut-account-note">{current.timing === "current" ? `${current.allowance} render slots in this verified period. Failed renders, previews, and downloads do not use a successful-render slot.` : "New render capacity is unavailable until a current verified billing period is confirmed."}</p></section>;
}

export default function AccountPage() {
  const button = useRef(null); const started = useRef(false); const coordinator = useRef(null);
  const [account, setAccount] = useState(null); const [usage, setUsage] = useState(null); const [usagePhase, setUsagePhase] = useState("idle");
  const [error, setError] = useState(""); const [logout, setLogout] = useState({ phase: "idle", error: "" }); const [signIn, setSignIn] = useState({ phase: "idle", error: "" });
  const [cancellation, setCancellation] = useState({ phase: "idle", error: "" });
  const load = useCallback(async () => {
    setError(""); setAccount(null); setUsage(null);
    try {
      const response = await fetch("/api/auth/session"); if (!response.ok) throw new Error("We could not load your account.");
      const next = await response.json(); setAccount(next);
      if (next.signedIn) { setUsagePhase("loading"); const usageResponse = await fetch("/api/account/usage"); if (!usageResponse.ok) throw new Error("We could not load your render usage."); setUsage(await usageResponse.json()); setUsagePhase("ready"); }
    } catch (loadError) { setError(loadError.message || "We could not load your account."); setUsagePhase("error"); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!clientId || account === null || account?.signedIn || started.current) return;
    started.current = true;
    const current = createGoogleSignInCoordinator({ fetchImpl: fetch, loadScript: () => loadGoogleIdentityScript(), render: (google) => { if (!button.current) return; button.current.replaceChildren(); google.accounts.id.renderButton(button.current, { theme: "outline", size: "large", width: 280, text: "continue_with" }); }, onState: setSignIn,
      onCredential: async ({ credential, nonce }) => { const response = await fetch("/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, nonce }) }); if (!response.ok) throw new Error("Google sign-in failed"); await load(); }
    }); coordinator.current = current; current.start();
  }, [account, load]);
  async function logoutCustomer() { if (logout.phase === "loading") return; setLogout({ phase: "loading", error: "" }); try { await performLogout(); started.current = false; setAccount({ signedIn: false }); setUsage(null); setLogout({ phase: "idle", error: "" }); } catch (logoutError) { setLogout({ phase: "error", error: logoutError.message || "We could not sign you out. Please try again." }); } }
  async function requestCancellation() { if (cancellation.phase === "loading") return; setCancellation({ phase: "loading", error: "" }); try { const response = await fetch("/api/billing/dodo/cancel", { method: "POST" }); const data = await response.json().catch(() => ({})); if (!response.ok || !data.scheduled) throw new Error(data.error || "We could not schedule cancellation."); setCancellation({ phase: "scheduled", error: "" }); await load(); } catch (cancelError) { setCancellation({ phase: "error", error: cancelError.message || "We could not schedule cancellation. Please try again." }); } }
  function retrySignIn() { started.current = true; coordinator.current?.retry(); }
  const status = accountState(account?.subscriptionStatus); const readiness = editingReadiness(account?.subscriptionStatus, usage);
  return <MarketingLayout><section className="cliponaut-account-page"><p className="cliponaut-marketing-eyebrow">Account</p><h1>Your Cliponaut Pro account</h1>{account === null && !error ? <p role="status">Loading your account…</p> : null}{error ? <div className="cliponaut-account-error" role="alert"><p>{error}</p><button type="button" onClick={load}>Try again</button></div> : null}
    {account?.signedIn ? <div className="cliponaut-account-stack"><section className="cliponaut-account-card"><p className="cliponaut-marketing-eyebrow">Signed in</p><h2>{account.email}</h2><div className="cliponaut-account-status"><strong>{status.title}</strong><p>{status.detail}</p></div><div className="cliponaut-account-status"><strong>{readiness.title}</strong><p>{readiness.detail}</p></div>{account.subscriptionStatus === "not_subscribed" || account.subscriptionStatus === "pending_verification" ? <CheckoutButton signedIn compact /> : null}{account.subscriptionStatus === "active" ? <div className="cliponaut-account-status"><strong>Manage subscription</strong><p>Cancellation stops renewal at the end of your verified billing period. Your existing access and unused render slots remain available until then. No automatic refund is promised.</p><button type="button" className="cliponaut-text-button" disabled={cancellation.phase === "loading"} onClick={requestCancellation}>{cancellation.phase === "loading" ? "Scheduling cancellation…" : "Cancel subscription"}</button>{cancellation.error ? <p className="cliponaut-account-inline-error" role="alert">{cancellation.error} <button type="button" onClick={requestCancellation}>Retry cancellation</button></p> : null}</div> : null}{account.subscriptionStatus === "cancellation_scheduled" || cancellation.phase === "scheduled" ? <div className="cliponaut-account-status"><strong>Cancellation scheduled</strong><p>Your Pro access ends at the verified end of this billing period. Renewal will not continue automatically.</p></div> : null}<button type="button" className="cliponaut-text-button" disabled={logout.phase === "loading"} onClick={logoutCustomer}>{logout.phase === "loading" ? "Signing out…" : "Sign out"}</button>{logout.error ? <p className="cliponaut-account-inline-error" role="alert">{logout.error} <button type="button" onClick={logoutCustomer}>Retry sign out</button></p> : null}</section><UsageCard usage={usage} phase={usagePhase} />{usagePhase === "error" ? <button type="button" className="cliponaut-text-button" onClick={load}>Retry usage</button> : null}</div> : null}
    {account && !account.signedIn ? <section className="cliponaut-account-card"><h2>Continue with Google</h2><p>Use your Google account to securely access Cliponaut and your verified subscription.</p>{!clientId ? <p role="status">Google sign-in is not configured yet.</p> : <>{signIn.phase === "loading" ? <p role="status">Preparing secure sign-in…</p> : null}<div ref={button} />{signIn.error ? <p role="alert">{signIn.error} <button type="button" onClick={retrySignIn}>Retry</button></p> : null}</>}</section> : null}
  </section></MarketingLayout>;
}

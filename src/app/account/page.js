"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckoutButton } from "@/components/cliponaut/CheckoutButton";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";
import { accountState, usageState } from "@/lib/account-presentation";
import { createGoogleSignInCoordinator, loadGoogleIdentityScript } from "@/lib/google-sign-in-client";

const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
function dateRange(period) { return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(period.start))} – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(period.end))}`; }

function UsageCard({ usage, phase }) {
  const current = usageState(usage);
  if (phase === "loading") return <section className="cliponaut-account-card" aria-busy="true"><p className="cliponaut-marketing-eyebrow">Render allowance</p><h2>Loading usage…</h2></section>;
  if (!current.available) return <section className="cliponaut-account-card"><p className="cliponaut-marketing-eyebrow">Render allowance</p><h2>Usage unavailable</h2><p>Verified billing-period information is needed before we can show usage safely.</p></section>;
  return <section className="cliponaut-account-card cliponaut-usage-card"><div><p className="cliponaut-marketing-eyebrow">This billing period</p><h2>{dateRange(current.billingPeriod)}</h2></div><div className="cliponaut-usage-grid"><p><strong>{current.successfulRenders}</strong><span>Successful renders</span></p><p><strong>{current.reservedRenders}</strong><span>Reserved / in progress</span></p><p><strong>{current.remainingRenders ?? "—"}</strong><span>Available slots</span></p></div><p className="cliponaut-account-note">{current.allowance} render slots per verified billing period. Failed renders, previews, and downloads do not use a successful-render slot.</p></section>;
}

export default function AccountPage() {
  const button = useRef(null); const started = useRef(false); const coordinator = useRef(null);
  const [account, setAccount] = useState(null); const [usage, setUsage] = useState(null); const [usagePhase, setUsagePhase] = useState("idle");
  const [error, setError] = useState(""); const [signIn, setSignIn] = useState({ phase: "idle", error: "" });
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
  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); started.current = false; setAccount({ signedIn: false }); setUsage(null); }
  function retrySignIn() { started.current = true; coordinator.current?.retry(); }
  const status = accountState(account?.subscriptionStatus);
  return <MarketingLayout><section className="cliponaut-account-page"><p className="cliponaut-marketing-eyebrow">Account</p><h1>Your Cliponaut Pro account</h1>{account === null && !error ? <p role="status">Loading your account…</p> : null}{error ? <div className="cliponaut-account-error" role="alert"><p>{error}</p><button type="button" onClick={load}>Try again</button></div> : null}
    {account?.signedIn ? <div className="cliponaut-account-stack"><section className="cliponaut-account-card"><p className="cliponaut-marketing-eyebrow">Signed in</p><h2>{account.email}</h2><div className="cliponaut-account-status"><strong>{status.title}</strong><p>{status.detail}</p></div>{account.subscriptionStatus === "not_subscribed" || account.subscriptionStatus === "pending_verification" ? <CheckoutButton signedIn compact /> : null}<button type="button" className="cliponaut-text-button" onClick={logout}>Sign out</button></section><UsageCard usage={usage} phase={usagePhase} />{usagePhase === "error" ? <button type="button" className="cliponaut-text-button" onClick={load}>Retry usage</button> : null}</div> : null}
    {account && !account.signedIn ? <section className="cliponaut-account-card"><h2>Continue with Google</h2><p>Use your Google account to securely access Cliponaut and your verified subscription.</p>{!clientId ? <p role="status">Google sign-in is not configured yet.</p> : <>{signIn.phase === "loading" ? <p role="status">Preparing secure sign-in…</p> : null}<div ref={button} />{signIn.error ? <p role="alert">{signIn.error} <button type="button" onClick={retrySignIn}>Retry</button></p> : null}</>}</section> : null}
  </section></MarketingLayout>;
}

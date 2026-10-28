"use client";
import { useEffect, useRef, useState } from "react";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";
import { createGoogleSignInCoordinator, loadGoogleIdentityScript } from "@/lib/google-sign-in-client";

const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;

export default function AccountPage() {
  const button = useRef(null); const started = useRef(false);
  const [account, setAccount] = useState(); const [signIn, setSignIn] = useState({ phase: "idle", error: "" });
  const coordinator = useRef(null);
  useEffect(() => { fetch("/api/auth/session").then((response) => response.ok ? response.json() : { signedIn: false }).then(setAccount).catch(() => setAccount({ signedIn: false })); }, []);
  useEffect(() => {
    // Wait for the session probe: this prevents anonymous initial rendering
    // from issuing two cookie-bound challenges that can arrive out of order.
    if (!clientId || account === undefined || account?.signedIn || started.current) return;
    started.current = true;
    const current = createGoogleSignInCoordinator({
      fetchImpl: fetch,
      loadScript: () => loadGoogleIdentityScript(),
      render: (google) => {
        if (!button.current) return;
        button.current.replaceChildren();
        google.accounts.id.renderButton(button.current, { theme: "outline", size: "large", width: 280, text: "continue_with" });
      },
      onState: setSignIn,
      onCredential: async ({ credential, nonce }) => {
        const response = await fetch("/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, nonce }) });
        if (!response.ok) throw new Error("Google sign-in failed");
        const session = await fetch("/api/auth/session");
        if (!session.ok) throw new Error("Session lookup failed");
        setAccount(await session.json());
      }
    });
    coordinator.current = current;
    current.start();
  }, [account]);
  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); started.current = false; setAccount({ signedIn: false }); }
  function retry() { started.current = true; coordinator.current.retry(); }
  return <MarketingLayout><section className="cliponaut-empty-state"><p className="cliponaut-marketing-eyebrow">Account</p><h1>Continue with Google</h1>{account?.signedIn ? <><p>Signed in as {account.email}.</p><button type="button" className="cliponaut-primary-button" onClick={logout}>Sign out</button></> : <><p>Use your Google account to securely sign in to Cliponaut.</p>{!clientId ? <p role="status">Google sign-in is not configured yet.</p> : <>{signIn.phase === "loading" && <p role="status">Preparing secure sign-in…</p>}<div ref={button} />{signIn.error && <p role="alert">{signIn.error} <button type="button" onClick={retry}>Retry</button></p>}</>}</>}</section></MarketingLayout>;
}

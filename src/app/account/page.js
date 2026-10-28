"use client";
import { useEffect, useRef, useState } from "react";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";

const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;

export default function AccountPage() {
  const button = useRef(null); const [account, setAccount] = useState(null); const [message, setMessage] = useState("");
  useEffect(() => { fetch("/api/auth/session").then((response) => response.json()).then(setAccount).catch(() => {}); }, []);
  useEffect(() => {
    if (!clientId || account?.signedIn) return;
    let cancelled = false;
    async function start() {
      const nonceResponse = await fetch("/api/auth/google/nonce"); const { nonce } = await nonceResponse.json();
      const script = document.createElement("script"); script.src = "https://accounts.google.com/gsi/client"; script.async = true;
      script.onload = () => {
        if (cancelled || !window.google) return;
        window.google.accounts.id.initialize({ client_id: clientId, nonce, callback: async ({ credential }) => {
          const response = await fetch("/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, nonce }) });
          if (response.ok) setAccount(await (await fetch("/api/auth/session")).json()); else setMessage("Google sign-in could not be completed.");
        } });
        if (button.current) window.google.accounts.id.renderButton(button.current, { theme: "outline", size: "large", width: 280, text: "continue_with" });
      };
      document.head.appendChild(script);
    }
    start().catch(() => setMessage("Google sign-in is temporarily unavailable."));
    return () => { cancelled = true; };
  }, [account?.signedIn]);
  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); setAccount({ signedIn: false }); }
  return <MarketingLayout><section className="cliponaut-empty-state"><p className="cliponaut-marketing-eyebrow">Account</p><h1>Continue with Google</h1>{account?.signedIn ? <><p>Signed in as {account.email}.</p><button type="button" className="cliponaut-primary-button" onClick={logout}>Sign out</button></> : <><p>Use your Google account to securely sign in to Cliponaut.</p>{clientId ? <div ref={button} /> : <p role="status">Google sign-in is not configured yet.</p>}{message && <p role="status">{message}</p>}</>}</section></MarketingLayout>;
}

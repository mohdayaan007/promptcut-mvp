"use client";
import { useEffect, useState } from "react";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";

export default function AccountPage() {
  const [email, setEmail] = useState(""); const [message, setMessage] = useState(""); const [account, setAccount] = useState(null);
  useEffect(() => { fetch("/api/auth/session").then((response) => response.json()).then(setAccount).catch(() => {}); }, []);
  async function requestLink(event) { event.preventDefault(); setMessage(""); const response = await fetch("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); const body = await response.json(); setMessage(body.message || body.error || "Please try again."); }
  async function logout() { await fetch("/api/auth/verify", { method: "DELETE" }); setAccount({ signedIn: false }); }
  return <MarketingLayout><section className="cliponaut-empty-state"><p className="cliponaut-marketing-eyebrow">Account</p><h1>Secure Cliponaut sign-in</h1>{account?.signedIn ? <><p>Signed in as {account.email}.</p><button type="button" className="cliponaut-primary-button" onClick={logout}>Sign out</button></> : <form onSubmit={requestLink}><p>Enter your email and we’ll send a secure, single-use sign-in link.</p><label htmlFor="account-email">Email address</label><input id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /><button className="cliponaut-primary-button" type="submit">Email me a sign-in link</button>{message && <p role="status">{message}</p>}</form>}</section></MarketingLayout>;
}

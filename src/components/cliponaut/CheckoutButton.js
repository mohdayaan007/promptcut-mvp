"use client";
import Link from "next/link";
import { useState } from "react";

export function CheckoutButton({ signedIn, compact = false }) {
  const [state, setState] = useState({ phase: "idle", message: "" });
  async function beginCheckout() {
    setState({ phase: "loading", message: "" });
    try {
      const response = await fetch("/api/billing/dodo/customer-checkout", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.checkoutUrl) throw new Error(data.error || "Checkout is not available in this environment.");
      window.location.assign(data.checkoutUrl);
    } catch (error) { setState({ phase: "error", message: error.message || "Checkout is not available in this environment." }); }
  }
  if (!signedIn) return <Link className="cliponaut-primary-button" href="/account">Sign in to continue</Link>;
  return <div className={compact ? "cliponaut-checkout-control is-compact" : "cliponaut-checkout-control"}>
    <button type="button" className="cliponaut-primary-button" disabled={state.phase === "loading"} onClick={beginCheckout}>{state.phase === "loading" ? "Checking access…" : "Continue to checkout"}</button>
    <p role={state.phase === "error" ? "alert" : "status"}>{state.message || "Checkout is available only in founder-authorized Test Mode."}</p>
  </div>;
}

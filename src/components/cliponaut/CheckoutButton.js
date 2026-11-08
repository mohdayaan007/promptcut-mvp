"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { RefundDisclosure } from "@/components/cliponaut/RefundDisclosure";

export function CheckoutButton({ signedIn, compact = false }) {
  const [state, setState] = useState({ phase: "idle", message: "" });
  const refundId = useId();
  async function beginCheckout() {
    setState({ phase: "loading", message: "" });
    try {
      const response = await fetch("/api/billing/dodo/customer-checkout", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.code === "checkout_reconciliation_required") {
        setState({ phase: "reconciliation", message: data.error || "Your earlier checkout needs review. Contact checkout support before trying again." });
        return;
      }
      if (!response.ok || !data.checkoutUrl) throw new Error(data.error || "Checkout is not available in this environment.");
      window.location.assign(data.checkoutUrl);
    } catch (error) { setState({ phase: "error", message: error.message || "Checkout is not available in this environment." }); }
  }
  return <div className={compact ? "cliponaut-checkout-control is-compact" : "cliponaut-checkout-control"}>
    <RefundDisclosure id={refundId} />
    {signedIn
      ? <button type="button" className="cliponaut-primary-button" aria-describedby={refundId} disabled={state.phase === "loading" || state.phase === "reconciliation"} onClick={beginCheckout}>{state.phase === "loading" ? "Checking access…" : state.phase === "reconciliation" ? "Checkout needs review" : "Continue to checkout"}</button>
      : <Link className="cliponaut-primary-button" href="/account" aria-describedby={refundId}>Sign in to continue</Link>}
    {signedIn && <p role={state.phase === "error" || state.phase === "reconciliation" ? "alert" : "status"}>{state.message || "Cliponaut Pro is $5/month until cancelled, with 15 successful renders per verified paid billing period."}</p>}
    {signedIn && state.phase === "reconciliation" && <p><Link href="/contact">Contact checkout support</Link>. Include the approximate attempt time. Do not send session cookies or checkout links.</p>}
  </div>;
}

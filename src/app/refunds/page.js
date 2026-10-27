import { PolicyPage } from "@/components/cliponaut/MarketingLayout";

export const metadata = { title: "Refund & Cancellation Policy — Cliponaut" };

export default function RefundsPage() {
  return (
    <PolicyPage eyebrow="Billing" title="Refund & Cancellation Policy" updated="Founder review pending">
      <p>Checkout is not currently available. This is a proposed policy for Cliponaut Pro and is not an unconditional refund promise. It must be confirmed by the founder and checked against Dodo Payments operating terms before publication.</p>
      <h2>Planned subscription</h2>
      <p>Cliponaut Pro is planned at $6 USD per month, recurring monthly. There is no free tier and no annual subscription. The proposed allowance is 15 successful renders per month, with exports up to 1080p MP4 during the paid beta.</p>
      <h2>Cancellation</h2>
      <p>When subscriptions launch, you should be able to cancel future renewals at any time through the subscription-management route provided at checkout. Cancellation will stop a future renewal; access for any already-paid period will be described in the final policy.</p>
      <h2>Proposed first-payment refund</h2>
      <p>Cliponaut plans to offer a 100% refund of the first subscription payment when requested within 7 days of that payment. This proposal is subject to founder approval and confirmation of Dodo Payments’ operational terms. It does not apply until the final policy is published at checkout.</p>
      <h2>How to ask for help</h2>
      <p>The official support contact and refund-request procedure have not yet been published. Before launch, this page must state how a customer submits a request, what information is needed to locate the payment, the review timeframe, and how approved refunds are returned.</p>
      <h2>Final policy notice</h2>
      <p>The terms displayed at checkout and the published final policy will control any subscription or refund request. This page will be updated before payments are accepted.</p>
    </PolicyPage>
  );
}

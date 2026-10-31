import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
export const metadata = { title: "Refund & Cancellation Policy — Cliponaut" };
export default function Refunds() { return <PolicyPage eyebrow="Billing" title="Refund & Cancellation Policy">
  <p><strong>Cliponaut is not currently accepting subscription payments.</strong> The following describes the intended paid-beta policy, not an active checkout agreement. Final binding terms will be displayed before checkout opens.</p>
  <h2>Pricing</h2>
  <p>Cliponaut Pro is planned at $6 USD per month, recurring monthly. The proposed plan includes 15 successful renders per billing period, with exports up to 1080p MP4 during paid beta. No annual subscription is currently planned.</p>
  <h2>Cancel future renewals</h2>
  <p>When subscriptions launch, customers will be able to request cancellation of future automatic renewals. Once cancellation is confirmed, Pro access and remaining render allowance will continue until the verified end of the current paid period. No new monthly charge should be initiated for a period after an effective period-end cancellation.</p>
  <h2>Refunds</h2>
  <p>Refund eligibility and procedures are still being finalized with the payment provider. There is no unconditional refund promise while checkout is closed. Any first-payment refund offer, exceptions, request deadlines and processing timeframes will be clearly published before payment is collected.</p>
  <h2>Help with a payment</h2>
  <p>For cancellation questions, unexpected charges or refund assistance, contact <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>. Do not send complete card numbers or other sensitive payment credentials by email.</p>
</PolicyPage>; }
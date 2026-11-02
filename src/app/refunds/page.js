import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
import { REFUND_FAILED_RENDERS, REFUND_RENDER_CUTOFF, REFUND_SUMMARY } from "@/lib/billing-policy";

export const metadata = { title: "Refund & Cancellation Policy — Cliponaut" };

export default function Refunds() { return <PolicyPage eyebrow="Billing" title="Refund & Cancellation Policy" updated="2 November 2026">
  <p>This policy explains refund requests and cancellation for Cliponaut Pro. Please read it before purchase. Checkout availability is shown in your account.</p>
  <h2>Pricing and render allowance</h2>
  <p>Cliponaut Pro is $5 USD per month, automatically recurring until cancelled, with no free trial. The plan includes 15 successful renders per verified paid billing period, with exports up to 1080p MP4 during paid beta. Failed or cancelled renders do not consume a successful-render slot.</p>
  <h2>Standard first-purchase refund eligibility</h2>
  <p><strong>{REFUND_SUMMARY}</strong> The 7-day window starts with your first successful subscription payment and does not restart on renewal.</p>
  <p><strong>{REFUND_RENDER_CUTOFF}</strong> {REFUND_FAILED_RENDERS} To remain eligible, do not complete a fourth successful render.</p>
  <p>The standard policy covers the first purchase, not later monthly renewal payments. Exceptions described below still apply.</p>
  <h2>How to request a refund</h2>
  <p>Email <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a> within the eligibility window. Include the email used for your Cliponaut purchase, your receipt or payment reference, and a short description of your request. Do not send full card numbers, payment credentials or sensitive video files.</p>
  <p>We review requests manually against your payment and successful-render records. Approved refunds are handled manually through Dodo Payments, our merchant of record, and returned to the original payment method. There is no automatic refund system. We will confirm the outcome by email; processing and bank posting times vary.</p>
  <h2>Consumer rights and exceptions</h2>
  <p>The standard time and usage limits do not remove rights under applicable consumer law or prevent review of duplicate charges and genuine technical failures. Contact us about these issues even if 7 days have passed or more than 3 successful renders were consumed. Dodo Payments may also provide remedies under its <a href="https://dodopayments.com/legal/buyer-terms">buyer terms</a>. This policy does not limit those rights or remedies.</p>
  <h2>Cancel future renewals</h2>
  <p>You can cancel anytime through your Cliponaut account. Once cancellation is confirmed, no further renewal is scheduled. Your Pro access and remaining render allowance continue until the end of your already-paid period, then paid access ends.</p>
  <p>If cancellation is not confirmed or you need help, email <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>. Cancellation and refund requests are separate: requesting cancellation does not itself issue a refund, and requesting a refund does not confirm cancellation. Check your account for cancellation confirmation.</p>
</PolicyPage>; }

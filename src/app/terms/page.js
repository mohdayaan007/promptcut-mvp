import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
import { RefundDisclosure } from "@/components/cliponaut/RefundDisclosure";
export const metadata = { title: "Terms of Service — Cliponaut" };
export default function Terms() { return <PolicyPage eyebrow="Legal" title="Terms of Service" updated="2 November 2026">
  <p>These terms describe access to Cliponaut, an early-access AI-assisted video editor available at cliponaut.com. Please review these terms and the refund policy before purchasing or using the service. Checkout availability is shown in your account.</p>
  <h2>Using Cliponaut</h2>
  <p>Cliponaut lets you upload video footage, describe editing changes, and create edited outputs. Features and availability vary during testing. You are responsible for reviewing every output before you publish or rely on it.</p>
  <h2>Rights to your content</h2>
  <p>Only upload material you own or are authorized to process. You remain responsible for the rights, consent, and lawful basis needed to upload, edit, and distribute videos, audio, images, likenesses, and other material. You permit Cliponaut and the service providers involved in processing to handle your uploaded content as necessary to provide the edit you request.</p>
  <h2>Prohibited use</h2>
  <p>Do not use the service for unlawful activity, infringement, harassment, identity misuse, deceptive impersonation, non-consensual intimate content, sexual exploitation, prohibited scraping, or other harmful content. See our <a href="/safety">Content Safety Policy</a>. We may reject requests, restrict access, or remove material to protect users or comply with the law.</p>
  <h2>Availability and outputs</h2>
  <p>Cliponaut is a developing product. We cannot guarantee uninterrupted availability, a particular edit quality, or the suitability or accuracy of AI-assisted decisions. Keep independent copies of your original footage and important outputs.</p>
  <h2>Subscriptions</h2>
  <p>Cliponaut Pro is $5 USD per month, automatically recurring until cancelled, with no free trial. Each verified paid billing period includes 15 successful renders. Failed or cancelled renders do not consume this allowance. Pending or failed renewal payments do not extend paid access or reset the allowance. You can cancel anytime through your account. Once cancellation is confirmed, no further renewal is scheduled and access continues until the end of your already-paid period. See <a href="/pricing">Pricing</a>.</p>
  <h2>Refund requests</h2>
  <RefundDisclosure />
  <p>The standard refund window applies to the first purchase, not later subscription renewals. Refunds are reviewed manually and approved refunds are processed through Dodo Payments; there is no automatic refund system. Contact <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a> with your purchase details. Exceptions apply for applicable consumer law, duplicate charges and genuine technical failures, including outside the standard time or usage limits. See the <a href="/refunds">full refund and cancellation policy</a>.</p>
  <p>Dodo Payments is our merchant of record. Its <a href="https://dodopayments.com/legal/buyer-terms">buyer terms</a> also apply. This policy does not limit your applicable legal rights or remedies under those terms.</p>
  <h2>Updates and contact</h2>
  <p>We may update these terms as the service evolves and will publish the updated date. Questions or reports may be sent to <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>.</p>
</PolicyPage>; }

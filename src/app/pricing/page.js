import Link from "next/link";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";

export const metadata = {
  title: "Pricing — Cliponaut",
  description: "Cliponaut Pro is planned at $6 USD per month. See plan details and current availability.",
};

const features = [
  ["Describe your edits", "Type an instruction instead of learning a complicated timeline."],
  ["Trim and combine", "Keep the moments you want and join clips into a single video."],
  ["Color and titles", "Change your video's look and add on-screen titles."],
  ["Edit conversationally", "Make follow-up editing requests as you refine a result."],
];

export default function PricingPage() {
  return <MarketingLayout>
    <section className="cliponaut-pricing-hero">
      <p className="cliponaut-marketing-eyebrow">Cliponaut Pro · Planned paid beta</p>
      <h1>Video editing, without the learning curve.</h1>
      <p>Upload footage and tell Cliponaut how you'd like it edited.</p>
    </section>
    <section className="cliponaut-plan-wrap" aria-label="Pro subscription">
      <div className="cliponaut-plan-card">
        <div className="cliponaut-plan-topline"><span className="cliponaut-member-badge">Early access</span><p>Monthly subscription</p></div>
        <h2>Cliponaut Pro</h2>
        <p className="cliponaut-plan-summary">Natural-language video editing for your own footage.</p>
        <p className="cliponaut-price"><span>$6</span> USD / month</p>
        <p className="cliponaut-plan-note">Planned recurring monthly billing · No annual plan</p>
        <div className="cliponaut-plan-rule" />
        <ul className="cliponaut-plan-list">
          <li>Proposed allowance: 15 successful renders per monthly billing period</li>
          <li>Planned paid-beta exports up to 1080p MP4</li>
          <li>Follow-up editing requests using natural language</li>
          <li>Cancel future renewals; access remains through the verified paid period</li>
        </ul>
        <div className="cliponaut-subscribe-pending" role="status">
          <strong>Paid checkout is not open yet.</strong>
          <span>Pricing and terms are being finalized. No payment can be made from this page. Contact us for early-access updates.</span>
        </div>
        <p style={{marginTop: "22px"}}><Link className="cliponaut-primary-button" href="/contact">Contact Cliponaut</Link></p>
      </div>
    </section>
    <section className="cliponaut-feature-section">
      <div className="cliponaut-section-heading">
        <p className="cliponaut-marketing-eyebrow">What the editor is built for</p>
        <h2>Describe the outcome. Keep the creative control.</h2>
      </div>
      <div className="cliponaut-feature-grid">
        {features.map(([name, detail], i) => <article className="cliponaut-feature" key={name}>
          <span>{String(i + 1).padStart(2, "0")}</span>
          <h3>{name}</h3><p>{detail}</p>
        </article>)}
      </div>
    </section>
    <section className="cliponaut-details-grid" aria-label="Subscription details">
      <article><p className="cliponaut-marketing-eyebrow">Before launch</p><h2>Transparent limits.</h2>
        <p>The price and allowance above describe the proposed paid beta. Final limits and all binding payment terms will be confirmed before checkout opens. Access to the existing editor may be offered separately during testing.</p>
      </article>
      <article className="cliponaut-guarantee"><p className="cliponaut-marketing-eyebrow">Your subscription</p><h2>Cancellation and refunds.</h2>
        <p>Subscribers will be able to stop future renewals. Confirmed cancellations keep already-paid access through the verified period end. Refund eligibility will be described in the final policy before payments are accepted.</p>
        <Link href="/refunds">Read refunds & cancellation</Link>
      </article>
    </section>
    <section className="cliponaut-faq"><p className="cliponaut-marketing-eyebrow">Questions</p><h2>Before you subscribe.</h2>
      <details><summary>Can I pay for Cliponaut Pro now?</summary><p>Not yet. Paid checkout is disabled while the subscription service and review are completed.</p></details>
      <details><summary>Is the $6 plan monthly?</summary><p>Yes. The planned Cliponaut Pro plan is $6 USD billed monthly, not annually.</p></details>
      <details><summary>Is there a permanent free tier?</summary><p>No permanent free tier is currently planned for the paid product. Separate early testing access may be available.</p></details>
      <details><summary>What about my uploaded videos?</summary><p>We process uploaded footage to perform your requested edits. Read our <Link href="/privacy">Privacy Policy</Link> and <Link href="/safety">Content Safety Policy</Link> for details.</p></details>
    </section>
  </MarketingLayout>;
}
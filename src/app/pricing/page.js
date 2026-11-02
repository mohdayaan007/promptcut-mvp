import Link from "next/link";
import { CheckoutButton } from "@/components/cliponaut/CheckoutButton";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";

export const metadata = {
  title: "Pricing — Cliponaut",
  description: "Cliponaut Pro is $5 USD per month, recurring until cancelled. Includes 15 successful renders per verified paid billing period.",
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
      <p className="cliponaut-marketing-eyebrow">Cliponaut Pro · Early access</p>
      <h1>Video editing, without the learning curve.</h1>
      <p>Upload footage and tell Cliponaut how you&apos;d like it edited.</p>
    </section>
    <section className="cliponaut-plan-wrap" aria-label="Pro subscription">
      <div className="cliponaut-plan-card">
        <div className="cliponaut-plan-topline"><span className="cliponaut-member-badge">Early access</span><p>Monthly subscription</p></div>
        <h2>Cliponaut Pro</h2>
        <p className="cliponaut-plan-summary">Natural-language video editing for your own footage.</p>
        <p className="cliponaut-price"><span>$5</span> USD / month</p>
        <p className="cliponaut-plan-note">Recurring monthly until cancelled · No free trial · No annual plan</p>
        <div className="cliponaut-plan-rule" />
        <ul className="cliponaut-plan-list">
          <li>15 successful renders per verified paid billing period</li>
          <li>Paid-beta exports up to 1080p MP4</li>
          <li>Follow-up editing requests using natural language</li>
          <li>Cancel future renewals; access remains through the verified paid period</li>
        </ul>
        <CheckoutButton signedIn={false} />
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
      <article><p className="cliponaut-marketing-eyebrow">Your allowance</p><h2>Transparent limits.</h2>
        <p>Your subscription includes 15 successful renders per verified paid billing period. Failed or cancelled renders do not consume a successful-render slot. A new allowance is granted only after renewal payment is confirmed.</p>
      </article>
      <article className="cliponaut-guarantee"><p className="cliponaut-marketing-eyebrow">Your subscription</p><h2>Cancellation and refunds.</h2>
        <p>Cancel anytime through your account. Once cancellation is confirmed, no further renewal is scheduled and access continues through your already-paid period. First-purchase refund requests are reviewed manually under the 7-day / maximum 3 successful renders policy.</p>
        <Link href="/refunds">Read refunds & cancellation</Link>
      </article>
    </section>
    <section className="cliponaut-faq"><p className="cliponaut-marketing-eyebrow">Questions</p><h2>Before you subscribe.</h2>
      <details><summary>Can I pay for Cliponaut Pro now?</summary><p>Sign in to your Cliponaut account to subscribe when checkout is enabled.</p></details>
      <details><summary>Is the $5 plan monthly?</summary><p>Yes. Cliponaut Pro is $5 USD billed monthly, automatically recurring until cancelled.</p></details>
      <details><summary>Is there a permanent free tier?</summary><p>No permanent free tier is currently planned for the paid product. Separate early testing access may be available.</p></details>
      <details><summary>What about my uploaded videos?</summary><p>We process uploaded footage to perform your requested edits. Read our <Link href="/privacy">Privacy Policy</Link> and <Link href="/safety">Content Safety Policy</Link> for details.</p></details>
    </section>
  </MarketingLayout>;
}

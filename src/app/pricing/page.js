import Link from "next/link";
import { CheckoutButton } from "@/components/cliponaut/CheckoutButton";
import { MarketingLayout } from "@/components/cliponaut/MarketingLayout";

const features = [
  ["ChatGPT for video editing", "Just tell Cliponaut how to edit your video."],
  ["Keep editing by chatting", "“Now make it black & white.”"],
  ["Find moments that matter", "“Keep only where I talk about my startup.”"],
  ["Keep just the part you want", "“Keep only 0:05 to 0:15.”"],
  ["Combine videos", "“Merge these two clips.”"],
  ["Change the look", "“Make it cinematic.” or “Give it a warm look.”"],
  ["Undo your last edit", "Use the one-click Undo action."],
  ["Preview & download", "Watch the result and save it as an MP4."],
];

export const metadata = {
  title: "Pricing — Cliponaut",
  description: "Cliponaut Pro — Early Access video editing.",
};

export default function PricingPage() {
  return (
    <MarketingLayout>
      <section className="cliponaut-pricing-hero" aria-labelledby="pricing-title">
        <p className="cliponaut-marketing-eyebrow">Simple, early access pricing</p>
        <h1 id="pricing-title">One plan. More room to make your video yours.</h1>
        <p>Cliponaut Pro is for editing video by simply saying what you want.</p>
      </section>

      <section className="cliponaut-plan-wrap" aria-label="Cliponaut Pro plan">
        <div className="cliponaut-plan-card">
          <div className="cliponaut-plan-topline">
            <span className="cliponaut-member-badge">Founding Member Access</span>
            <p>Early access</p>
          </div>
          <p className="cliponaut-member-note">Early paid beta access at the introductory price shown here.</p>
          <h2>Cliponaut Pro</h2>
          <p className="cliponaut-plan-summary">Natural-language video editing for your real projects.</p>
          <p className="cliponaut-price"><span>$6</span> USD / month</p>
          <p className="cliponaut-plan-note">Recurring monthly. No free tier. No annual plan.</p>
          <div className="cliponaut-plan-rule" />
          <ul className="cliponaut-plan-list">
            <li>Proposed allowance: up to 15 successful renders each month</li>
            <li>Exports up to 1080p MP4 during the paid beta</li>
            <li>Cancel future renewals any time</li>
          </ul>
          <div className="cliponaut-subscribe-pending" role="status">
            <strong>Founder-approved Test Mode only.</strong>
            <span>Checkout remains unavailable unless the server authorizes this environment.</span>
          </div>
          <CheckoutButton signedIn={false} />
        </div>
      </section>

      <section className="cliponaut-feature-section" aria-labelledby="features-title">
        <div className="cliponaut-section-heading">
          <p className="cliponaut-marketing-eyebrow">What you can do</p>
          <h2 id="features-title">Edit by describing the result.</h2>
        </div>
        <div className="cliponaut-feature-grid">
          {features.map(([title, detail], index) => (
            <article className="cliponaut-feature" key={title}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="cliponaut-details-grid" aria-label="Plan details">
        <article>
          <p className="cliponaut-marketing-eyebrow">A focused beta</p>
          <h2>Clear limits from the start.</h2>
          <p>The paid beta currently focuses on successful edits and exports up to 1080p. The proposed monthly allowance is 15 successful renders. It is not yet enforced and may change before checkout opens.</p>
        </article>
        <article className="cliponaut-guarantee">
          <p className="cliponaut-marketing-eyebrow">Founder approval pending</p>
          <h2>First-payment refund</h2>
          <p>We plan to offer a 100% refund of the first subscription payment within 7 days. This policy is pending confirmation of Dodo Payments operating terms and founder approval; it is not a current unconditional promise.</p>
          <Link href="/refunds">Read the refund & cancellation policy</Link>
        </article>
      </section>

      <section className="cliponaut-faq" aria-labelledby="faq-title">
        <p className="cliponaut-marketing-eyebrow">FAQ</p>
        <h2 id="faq-title">A few useful details.</h2>
        <details>
          <summary>Is there a free plan?</summary>
          <p>No. Cliponaut Pro is the single planned offering.</p>
        </details>
        <details>
          <summary>Can I cancel?</summary>
          <p>Yes. When subscriptions launch, you will be able to cancel future renewals at any time.</p>
        </details>
        <details>
          <summary>What quality can I export?</summary>
          <p>The paid beta is planned for exports up to 1080p MP4.</p>
        </details>
        <details>
          <summary>Does Cliponaut offer unlimited renders?</summary>
          <p>No. The proposed allowance is 15 successful renders per month.</p>
        </details>
      </section>
    </MarketingLayout>
  );
}

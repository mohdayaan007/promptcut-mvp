import { PolicyPage } from "@/components/cliponaut/MarketingLayout";

export const metadata = { title: "Terms of Service — Cliponaut" };

export default function TermsPage() {
  return (
    <PolicyPage eyebrow="Terms" title="Terms of Service" updated="Founder review pending">
      <p>These are draft terms for Cliponaut. They must be reviewed and completed with the provider’s legal identity, governing law, and contact details before the paid service is launched.</p>
      <h2>The service</h2>
      <p>Cliponaut is a natural-language video-editing service. You upload video and describe requested edits; Cliponaut processes those materials to generate an output. Results can vary with source material and the instruction given.</p>
      <h2>Your responsibilities</h2>
      <p>You are responsible for your uploads, prompts, and use of outputs. You must have all rights, permissions, and lawful basis needed to upload, process, edit, and share your materials. Do not use the service for unlawful, harmful, infringing, or privacy-violating activity.</p>
      <h2>Availability and product limits</h2>
      <p>The service is an early-access product. Features, technical limits, supported formats, render allowances, and availability may evolve. The proposed Cliponaut Pro allowance is 15 successful renders per month, and paid-beta exports are planned up to 1080p MP4. These are not yet enforced because checkout is not live.</p>
      <h2>Subscriptions</h2>
      <p>If subscriptions are launched, Cliponaut Pro is planned as a $6 USD recurring monthly subscription with no free tier and no annual option. You will be able to cancel future renewals. Final billing, cancellation, and refund terms will be presented before payment is collected.</p>
      <h2>Content and outputs</h2>
      <p>You retain responsibility for your source content. You must review an output before relying on or sharing it. Cliponaut does not guarantee that any requested edit, AI interpretation, or output will be error-free or suitable for a particular purpose.</p>
      <h2>Suspension and changes</h2>
      <p>We may suspend access to protect the service, users, or rights holders, or where required by law. The final terms will state the applicable notice process, liability terms, governing law, and dispute process.</p>
    </PolicyPage>
  );
}

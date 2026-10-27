import { PolicyPage } from "@/components/cliponaut/MarketingLayout";

export const metadata = { title: "Contact & Support — Cliponaut" };

export default function ContactPage() {
  return (
    <PolicyPage eyebrow="Support" title="Contact & Support" updated="Founder review pending">
      <p>We’re preparing support for Cliponaut Pro. An official support email or contact form has not been published yet, so this page intentionally does not invent one.</p>
      <h2>What we can help with</h2>
      <p>Support will cover access, billing and cancellation questions, refund requests, uploaded-video processing issues, and privacy requests.</p>
      <h2>Before paid access opens</h2>
      <p>The founder needs to provide an official support contact, expected response time, business identity, and the process for handling billing and refund requests. Once confirmed, those details will appear here and in the relevant policy pages.</p>
      <h2>Product feedback</h2>
      <p>Cliponaut is in early access. Please include a clear description of the issue, the action you took, and any relevant error message when support is available. Do not send payment details or sensitive video content through an unsecured channel.</p>
    </PolicyPage>
  );
}

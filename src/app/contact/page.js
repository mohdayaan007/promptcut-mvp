import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
export const metadata = { title: "Contact & Support — Cliponaut" };
export default function Contact() { return <PolicyPage eyebrow="Support" title="Contact & Support">
  <p>For product questions, early-access inquiries, payment questions, content safety reports, privacy requests or technical support, email <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>.</p>
  <h2>What to include</h2>
  <p>Describe what you were trying to do, any error message, and the approximate time the problem occurred. For video-related issues, avoid emailing sensitive media or payment information; ask for a secure support method instead.</p>
  <h2>Reporting prohibited content</h2>
  <p>To report suspected non-consensual, impersonation, infringing or otherwise prohibited content, email us with the relevant details and a clear subject line. See the <a href="/safety">Content Safety Policy</a>.</p>
  <h2>Payment availability</h2>
  <p>Cliponaut Pro checkout is not yet open to the public. The proposed plan is described on our <a href="/pricing">Pricing</a> page.</p>
</PolicyPage>; }
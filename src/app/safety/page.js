import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
export const metadata = { title: "Content Safety & Acceptable Use — Cliponaut" };
export default function Safety() { return <PolicyPage eyebrow="Responsible use" title="Content Safety & Acceptable Use">
  <p>Cliponaut is an AI-assisted editor for footage that users have the right to edit. It is not intended as a tool for deceptive impersonation, scraping other people's content, or creating non-consensual deepfakes.</p>
  <h2>Rights and consent</h2>
  <p>Only upload videos, images, audio, voices and likenesses you own or have permission to use. Respect copyright, privacy, publicity rights and all relevant consent requirements.</p>
  <h2>Prohibited activity</h2>
  <p>Do not use Cliponaut to create or facilitate non-consensual sexual imagery, sexual exploitation of minors, deceptive identity impersonation, malicious deepfakes, harassment, fraud, misinformation intended to harm, unlawful surveillance, unauthorized scraping, or unlawful distribution of protected media.</p>
  <h2>How footage is handled</h2>
  <p>Editing may involve inspecting video frames and audio, generating editing instructions, and producing a new encoded output. AI-assisted planning does not imply that source footage is factually accurate or that every misuse is automatically detected. Users are responsible for reviewing outputs before distribution.</p>
  <h2>Enforcement and reporting</h2>
  <p>We may restrict access, reject content, or remove material when necessary to respond to prohibited uses or legal requirements. Automated checks are not a guarantee that all harmful content will be detected. Report concerns to <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>.</p>
</PolicyPage>; }
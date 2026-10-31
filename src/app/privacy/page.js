import { PolicyPage } from "@/components/cliponaut/MarketingLayout";
export const metadata = { title: "Privacy Policy — Cliponaut" };
export default function Privacy() { return <PolicyPage eyebrow="Privacy" title="Privacy Policy">
  <p>Cliponaut processes information to deliver AI-assisted video edits. This page describes our current early-access practices. If you have privacy or deletion questions, contact <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a>.</p>
  <h2>Information collected</h2>
  <p>When you use Cliponaut, we may process uploaded video and audio, reference materials you provide, editing prompts, generated previews and exports, technical usage logs, and the information needed to maintain sessions. If account features are enabled, we may also process account identifiers such as your email address and subscription status.</p>
  <h2>Processing uploads</h2>
  <p>We process your media and instructions to inspect source footage, plan edits, render results, deliver downloads and diagnose failures. Certain requests can involve third-party infrastructure or AI services. Files and prompts should not contain information you are not permitted to share or process.</p>
  <h2>Storage and retention</h2>
  <p>Uploaded footage, editing history and rendered files may be retained to support editing, access to completed work, troubleshooting and service security. Retention varies by type of data and processing path; a universal automatic-deletion window is not currently promised. Contact us to request deletion or information about specific stored material. Some records may be kept where necessary for security, billing or legal requirements.</p>
  <h2>Sharing and security</h2>
  <p>We use service providers for hosting, storage and relevant processing. Information may be made available to those providers as needed to operate Cliponaut. We do not authorize other users to access your private editing work. No online service can guarantee absolute security.</p>
  <h2>Your rights and requests</h2>
  <p>For data access, correction, deletion, or privacy questions, email <a href="mailto:cliponauthq@gmail.com">cliponauthq@gmail.com</a> with enough information for us to identify your request without including sensitive payment credentials.</p>
  <h2>Updates</h2>
  <p>We will update this policy as paid accounts, provider relationships and documented retention schedules are finalized, including any additional disclosures required before paid access launches.</p>
</PolicyPage>; }
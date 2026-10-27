import { PolicyPage } from "@/components/cliponaut/MarketingLayout";

export const metadata = { title: "Privacy Policy — Cliponaut" };

export default function PrivacyPage() {
  return (
    <PolicyPage eyebrow="Privacy" title="Privacy Policy" updated="Founder review pending">
      <p>This draft explains how Cliponaut handles information while you use its video-editing service. It is not final legal advice and must be completed with the founder’s business and contact details before publication.</p>
      <h2>Information we handle</h2>
      <p>We handle the details you provide to use the service, such as uploaded video files, editing prompts, and information needed to operate an account or subscription once those features are available.</p>
      <h2>Video uploads and AI processing</h2>
      <p>Cliponaut processes uploaded videos and your editing instructions to create the edit you request. Processing may include media inspection, transcription or understanding of spoken or visible content, AI-assisted planning, and deterministic video rendering. Do not upload content you do not have the right to use or content that unlawfully includes another person’s personal information.</p>
      <h2>Storage and retention</h2>
      <p>Uploads and rendered outputs are stored privately to provide the service. Retention periods, deletion procedures, backup handling, and the list of service providers are still to be confirmed. This page will be updated with those details before paid access is launched.</p>
      <h2>How information is used</h2>
      <p>We use information to provide and secure the service, process your requested edits, support users, prevent misuse, and meet applicable legal obligations. We do not describe any sale of personal information in this draft.</p>
      <h2>Your choices</h2>
      <p>You may contact us about privacy questions, deletion requests, or access requests using the contact route below once the official support contact has been published. Some information may need to be retained where required for security, legal, or operational reasons.</p>
      <h2>Changes and contact</h2>
      <p>Material updates will be reflected by changing this policy’s effective date. Official business identity and privacy contact details are not yet published.</p>
    </PolicyPage>
  );
}

import { getAiCapabilityContract } from "@/lib/editor-core/capability-registry";

export function buildAiEditorPrompt({ prompt, hasSecondVideo }) {
  const capabilities = JSON.stringify(getAiCapabilityContract({ hasSecondVideo }));

  return [
    "You are Cliponaut's AI video editor.",
    "Translate the user's request into a Cliponaut edit plan. You do not render video and never write FFmpeg commands.",
    "Use the video for visual context and timestamps only when the request needs it.",
    "Select only the supported operations and values below. Never invent unsupported capabilities.",
    "If the request is unsupported, return an empty operations array.",
    "Return only JSON matching the supplied schema.",
    `Supported capability contract: ${capabilities}`,
    `User request: ${prompt}`
  ].join("\n\n");
}

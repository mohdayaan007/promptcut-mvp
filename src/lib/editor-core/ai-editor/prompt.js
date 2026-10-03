import { getAiCapabilityContract } from "@/lib/editor-core/capability-registry";

export function buildAiEditorPrompt({ prompt, hasMultipleVideos = false, sourceCatalog = [] }) {
  const capabilities = JSON.stringify(getAiCapabilityContract({ hasMultipleVideos }));

  return [
    "You are Cliponaut's AI video editor.",
    "Translate the user's request into a Cliponaut edit plan. You do not render video and never write FFmpeg commands.",
    "Use the video for visual context and timestamps only when the request needs it.",
    "Select only the supported operations and values below. Never invent unsupported capabilities.",
    "For version 1, timestamps use the existing input timeline. In version 2, sequence clip timestamps are source-local and unscoped operations use the final assembled timeline. Use crop for deterministic center framing only; never claim subject or face tracking.",
    "Zoom must be a smooth center-based zoom with a start, end, and safe amount. Speed may be global or a single source-time range.",
    "Fade is applied on the final output timeline, so use it only for beginning/end fades.",
    sourceCatalog.length
      ? "For an explicit or visual source request, return version 2 with exactly one sequence operation. Each sequence clip uses source-local timestamps. " +
        "Use sourceId only from the authoritative catalog: video 1, first video, and source-1 all mean source-1. Explicit ordinal/source references are authoritative. " +
        "For semantic descriptions such as house, road, indoor, outdoor, or greenery, identify the matching supplied video visually and emit its sourceId. " +
        "If a semantic description does not identify exactly one source with confidence, return an empty operations array. Filenames are descriptive only and must never be identifiers. " +
        "Source-scoped color_grade is allowed; title, zoom, speed, crop, and fade remain global after sequence assembly."
      : "No source catalog is available; do not emit source-aware operations.",
    "If the request is unsupported, return an empty operations array.",
    "Return only JSON matching the supplied schema.",
    `Supported capability contract: ${capabilities}`,
    sourceCatalog.length ? `Authoritative source catalog: ${JSON.stringify(sourceCatalog)}` : null,
    `User request: ${prompt}`
  ].filter(Boolean).join("\n\n");
}

import { getAiCapabilityContract } from "@/lib/editor-core/capability-registry";

export function buildSemanticSourceClassificationPrompt({ source, semanticReferences }) {
  return [
    "You classify whether this one supplied video plausibly matches each requested source description. You do not create an edit plan.",
    "Judge only THIS source independently. Do not compare it with other sources, choose a best source, or infer a winner.",
    "For every semantic reference, set plausibleMatch to true only when this source plausibly matches that visual description; otherwise set it to false.",
    "Do not use filenames as visual evidence. Return only JSON matching the supplied schema.",
    `Authoritative source: ${JSON.stringify(source)}`,
    `Semantic references: ${JSON.stringify(semanticReferences)}`
  ].join("\n\n");
}

export function buildVisualMomentLocalizationPrompt({ source, moment }) {
  return [
    "You localize visually observable moments inside this one supplied video. You do not create an edit plan.",
    "Judge only THIS source. Return every genuinely plausible occurrence of the requested moment; do not choose a best occurrence and do not compare other sources.",
    "Treat the requested moment as a conjunction of all meaningful visible constraints. A candidate is valid only when every essential subject, object, action, setting, direction, relationship, and state in the request is visibly supported together in that same occurrence.",
    "Never return a partial semantic match: generic action similarity is insufficient. If any essential concrete detail is absent, not visibly supported, or uncertain, return an empty candidates array. Prefer a false negative over stretching or inventing a partial match.",
    "For example: 'person walks through the temple' is valid only when a person visibly walks through a temple or temple structure, not when they walk through a forest or generic path. 'car enters the frame' requires a car moving from outside or not visible into frame, not a stationary car already present. 'person sits on the chair' requires the person visibly performing the sitting action onto a chair, not merely a nearby chair.",
    "Each candidate must be a bounded visual occurrence with start and end timestamps in seconds. For paired boundaries, each candidate must pair the requested start and end events from the same plausible range.",
    "Continue returning all genuinely valid full occurrences. If the event does not occur in this source, return an empty candidates array. Do not use filenames as visual evidence. Return only JSON matching the supplied schema.",
    `Authoritative source: ${JSON.stringify(source)}`,
    `Moment request: ${JSON.stringify(moment)}`
  ].join("\n\n");
}

export function buildSemanticTranscriptMatchPrompt({ source, moment, transcript }) {
  const segments = transcript.segments.map(({ segmentId, text }) => ({ segmentId, text }));
  return [
    "You localize a semantic spoken topic within one authoritative transcript. You do not create an edit plan.",
    "Judge only this source. Return every genuinely plausible coherent occurrence; do not choose a best occurrence or compare sources.",
    "For EVENT_SEGMENT, select the whole coherent discussion, including relevant introduction and supporting statements, but exclude the transition to a different topic.",
    "For START_BOUNDARY and END_BOUNDARY, return the segment range that identifies the requested spoken topic boundary. For START_END_BOUNDARY, return an ordered range from the requested start topic through the requested end topic.",
    "Return only canonical startSegmentId and endSegmentId from the supplied transcript. Never return timestamps, offsets, source ranges, or invented segment IDs. If no complete plausible occurrence exists, return an empty candidates array.",
    `Authoritative source: ${JSON.stringify({ sourceId: source.sourceId, duration: source.duration })}`,
    `Moment request: ${JSON.stringify(moment)}`,
    `Canonical transcript segments: ${JSON.stringify(segments)}`
  ].join("\n\n");
}

/**
 * This classifier receives only request text. Profile IDs are internal semantic
 * labels; the server owns source scope, recipes, renderer settings, and plans.
 */
export function buildStyleIntentPrompt({ prompt }) {
  return [
    "You classify the user's text-only visual styling intent. You do not create an edit plan, inspect media, choose sources, or return rendering controls.",
    "Choose exactly one dominant internal family only when the wording gives a clear requested aesthetic: clean_commercial (clean, polished, refined, premium, professional, restrained); warm_travel (inviting, warm lifestyle/travel, vacation or holiday warmth, welcoming); cinematic (dramatic, filmic, serious, movie-like); soft_nostalgic (soft, faded, dreamy, memory-like, nostalgic or vintage); vibrant_social (lively, energetic, colourful, punchy, upbeat social); dark_moody (dark, moody, brooding, atmospheric); natural_documentary (realistic, understated, natural, documentary-like, minimally stylized).",
    "For semantic_style, select one profileId from that catalog, a bounded strength, applicable catalog constraints, whether the request includes another edit, and styleText: the exact verbatim substring of the user's request that expresses only the aesthetic request. Never stack profiles. Do not include source references or another edit in styleText.",
    "For delegated_taste, use profileId 'none', strength 'standard', no constraints, and styleText as the exact verbatim substring requesting content-aware aesthetic judgment when the user asks you to decide based on footage, such as 'make this look good', 'make this better', 'do whatever looks best', 'choose whatever style suits this footage', 'make it look as good as possible', or 'fix the look'. Do not include another edit or source reference in styleText.",
    "For not_style, use profileId 'none', strength 'standard', no constraints, and styleText '' when the request is not visual styling. Never return source IDs, profile versions, recipes, numeric adjustments, FFmpeg filters, LUTs, paths, or arbitrary fields.",
    "Return only JSON matching the supplied schema.",
    `User request: ${prompt}`
  ].join("\n\n");
}

/**
 * This prompt receives already-active video parts, but never source IDs or
 * renderer controls. It selects only among server-owned profile semantics.
 */
export function buildDelegatedStyleDecisionPrompt() {
  return [
    "You choose one tasteful visual treatment for the supplied video footage. You do not create an edit plan, select sources, or return renderer controls.",
    "Choose the treatment that would improve the footage into a tasteful, intentional, polished, publishable result. Consider subject matter, environment, lighting, exposure, color character, energy, emotional tone, prominent people/faces, and whether aggressive styling would damage the material.",
    "Available families: clean_commercial for restrained polished product, business, brand, or lifestyle footage; warm_travel for welcoming travel, food, holidays, outdoor lifestyle, or human moments; cinematic for dramatic landscapes, architecture, narrative material, or strong filmic potential; soft_nostalgic for intimate, memory-like, emotional, retro, family, or quiet lifestyle storytelling; vibrant_social for energetic creator, event, upbeat lifestyle, colourful, or high-energy scenes; dark_moody only for genuinely atmospheric, night, interior, or dramatic footage when darkening improves visibility; natural_documentary for realistic documentary, interview, everyday, or authenticity-first material.",
    "Do not choose dark_moody merely because footage is dark, warm_travel merely because it is outdoors, or clean_commercial as a default for uncertainty. For multiple supplied clips, choose one coherent global treatment rather than a per-clip choice.",
    "Use constraints conservatively: skin_tone_conservative when prominent people/faces make aggressive color risky; avoid_darkening when footage is already dark or underexposed; avoid_oversaturation when it is already saturated; conservative_color when realistic color should remain restrained. These are global conservative treatments, never selective corrections.",
    "Choose subtle only when mild polish is appropriate, standard for the normal useful treatment, and strong only when the material genuinely benefits from a pronounced aesthetic. If no safe tasteful choice can be made, return no_safe_choice with profileId 'none', strength 'standard', and no constraints.",
    "Return only JSON matching the supplied schema. Never return source IDs, profile versions, recipes, numeric adjustments, FFmpeg filters, LUTs, paths, or arbitrary fields."
  ].join("\n\n");
}

export function buildAiEditorPrompt({ prompt, hasMultipleVideos = false, sourceCatalog = [], resolvedSemanticSources = [], authoritativeMomentSequence = null, referenceStyleActive = false }) {
  const capabilities = JSON.stringify(getAiCapabilityContract({
    hasMultipleVideos,
    supportsSequence: hasMultipleVideos || Boolean(authoritativeMomentSequence)
  }));

  return [
    "You are Cliponaut's AI video editor.",
    "Translate the user's request into a Cliponaut edit plan. You do not render video and never write FFmpeg commands.",
    "Use the video for visual context and timestamps only when the request needs it.",
    "Select only the supported operations and values below. Never invent unsupported capabilities.",
    "For version 1, timestamps use the existing input timeline. In version 2, sequence clip timestamps are source-local and unscoped operations use the final assembled timeline. Use crop for deterministic center framing only; never claim subject or face tracking.",
    "Zoom must be a smooth center-based zoom with a start, end, and safe amount. Speed may be global or a single source-time range.",
    "Fade is applied on the final output timeline, so use it only for beginning/end fades.",
    "audio_volume controls final-output audio only: use factor 0 for mute, an exact percentage as its decimal factor, 0.5 for quieter/lower/decrease, and 1.5 for louder/increase. audio_fade fades final-output audio only. 'Fade out at the end' uses the audiovisual fade operation; explicit 'Fade the audio ...' wording uses audio_fade and never fades video. Do not invent music, mixing, ducking, or other audio capabilities.",
    "visual_adjustment uses only normalized bounded values from -1 to 1 for brightness, contrast, saturation, temperature, and tint. Positive temperature is warmer; positive tint is magenta. Never emit FFmpeg filters or arbitrary visual fields. 'Warm filter' and 'cool look' remain named color_grade presets; 'make it warmer' or 'make it cooler' are visual_adjustment requests.",
    referenceStyleActive ? "A server-authoritative reference style treatment is active for this request. Plan all non-style operations the user requests, but do not emit style_profile, color_grade, or visual_adjustment. Do not replace, combine with, or reinterpret the reference treatment." : null,
    "Title timestamps use the final assembled output timeline after sequence, trim, and speed. A title may include rich runs; concatenate every run's text to reproduce title.text exactly. Select exact fonts only from the catalog. For a stylistic font request, set fontIntent to a catalog-supported semantic tag while still providing a catalog font fallback. Never invent font files, colors, positions, or renderer syntax.",
    "For subtitles or captions, emit one captions operation with optional styling only. Never emit transcript text, words, source timestamps, or caption cues: the server owns all speech text and final-output timing.",
    sourceCatalog.length
      ? "For an explicit or visual source request, return version 2 with exactly one sequence operation. Each sequence clip uses source-local timestamps. " +
        "Use sourceId only from the authoritative catalog: video 1, first video, and source-1 all mean source-1. Explicit ordinal/source references are authoritative. " +
        "For semantic descriptions such as house, road, indoor, outdoor, or greenery, identify the matching supplied video visually and emit its sourceId. " +
        "If a semantic description does not identify exactly one source with confidence, return an empty operations array. Filenames are descriptive only and must never be identifiers. " +
        "Use exactly one color_grade operation per plan. For a request to grade both, all, or every video, use one unscoped color_grade without sourceId so it applies after sequence assembly; never emit one color_grade per source. Use sourceId only when the request explicitly limits the grade to one source, such as 'only video 2'. Title, zoom, speed, crop, and fade remain global after sequence assembly."
      : "No source catalog is available; do not emit source-aware operations.",
    resolvedSemanticSources.length
      ? `Authoritative resolved semantic sources: ${JSON.stringify(resolvedSemanticSources)}. Use these source IDs for their matching descriptions; do not reinterpret them.`
      : null,
    authoritativeMomentSequence
      ? `Authoritative localized sequence: ${JSON.stringify(authoritativeMomentSequence)}. Include it exactly; its source IDs, order, and timestamps are server-resolved and must not be changed.`
      : null,
    "If the request is unsupported, return an empty operations array.",
    "Return only JSON matching the supplied schema.",
    `Supported capability contract: ${capabilities}`,
    sourceCatalog.length ? `Authoritative source catalog: ${JSON.stringify(sourceCatalog)}` : null,
    `User request: ${prompt}`
  ].filter(Boolean).join("\n\n");
}

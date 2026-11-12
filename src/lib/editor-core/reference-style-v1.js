import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";

export const REFERENCE_STYLE_V1_VERSION = "reference-style/1";
const fail = (message) => { throw new Error(`Invalid Reference Style V1 profile: ${message}`); };
const validAnimation = new Set(["phrase_rise", "phrase_slide", "none"]);
const validFamily = new Set(["condensed_sans", "expressive_serif", "sans_serif"]);

export function createReferenceStyleV1Profile({ referenceId, colour, typography, evidence }) {
  if (!referenceId || !colour || !typography || !evidence) fail("missing profile fields");
  const treatment = createCanonicalReferenceStyleTreatment({ version: 2, recipe: colour.recipe });
  if (!validFamily.has(typography.primaryFamily) || !validFamily.has(typography.secondaryFamily) || !validAnimation.has(typography.animation)) fail("unsupported typography treatment");
  if (!Array.isArray(evidence.frames) || !evidence.frames.length || !["high", "medium", "low"].includes(evidence.confidence)) fail("invalid evidence");
  return Object.freeze({ version: REFERENCE_STYLE_V1_VERSION, referenceId, colour: Object.freeze({ treatment, confidence: colour.confidence || "medium", limitations: Object.freeze(colour.limitations || []) }), typography: Object.freeze({ ...typography }), evidence: Object.freeze({ ...evidence, frames: Object.freeze([...evidence.frames]) }) });
}

/** Offline-only observed profile: no model claim, no extracted reference copy. */
export function createRve1OfflineProfile() {
  return createReferenceStyleV1Profile({
    referenceId: "rve1-moved-to-blore", colour: { confidence: "medium", limitations: ["Global grading cannot reproduce the reference's scene-specific exposure or film texture."], recipe: { brightness: -0.012, contrast: 0.06, saturation: -0.06, temperature: -0.04, tint: -0.025, shadows: -0.025, highlights: -0.02, vibrance: -0.02, shadowTemperature: -0.02, midtoneTemperature: -0.035, highlightTemperature: -0.015 } },
    typography: { primaryFamily: "condensed_sans", secondaryFamily: "expressive_serif", alignment: "left", textColours: ["#f8d363", "#ed4b3a"], hierarchy: "display-plus-serif", animation: "phrase_rise", confidence: "medium" },
    evidence: { confidence: "medium", frames: ["reference-frame-1", "reference-frame-3", "reference-frame-5"], observations: ["muted cool-green street palette", "large condensed display type paired with expressive serif", "short phrase-level entrances and warm accent colours"], uncertain: ["exact fonts", "frame-accurate animation timings", "per-scene exposure choices"] }
  });
}

export function resolveReferenceStyleTitle({ profile, providedText = null, noText = false, sourceEvidence = null }) {
  if (noText) return null;
  if (providedText && typeof providedText === "string" && providedText.trim().length <= 48) return Object.freeze({ text: providedText.trim(), origin: "creator_supplied", confidence: "high" });
  if (!profile?.typography || !sourceEvidence?.observedStreetMotion) return null;
  return Object.freeze({ text: "CITY MOTION", origin: "offline_visual_suggestion", confidence: "low", requiresCreatorApproval: true });
}

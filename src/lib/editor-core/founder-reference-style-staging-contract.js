import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";

export const FOUNDER_REFERENCE_STYLE_STAGING_VERSION = "founder-reference-style-staging/1";
export const FOUNDER_REFERENCE_STYLE_ASSETS = Object.freeze({
  reference: Object.freeze({ id: "founder-rve1-moved-to-blore", key: "founder-reference-style/v1/reference.mp4" }),
  source: Object.freeze({ id: "founder-gym-outside", key: "founder-reference-style/v1/source.mp4" }),
  profile: Object.freeze({ id: "founder-rve1-style-profile", key: "founder-reference-style/v1/style-profile.json" })
});

const confidence = new Set(["low", "medium", "high"]);
const warmth = new Set(["cool", "neutral", "warm"]);
const saturation = new Set(["low", "medium", "high"]);
const contrast = new Set(["low", "medium", "high"]);
const typography = new Set(["none", "condensed_sans", "serif", "mixed"]);
const animation = new Set(["none", "phrase_rise", "phrase_slide"]);
const sha256 = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(`Invalid founder Reference Style staging data: ${message}`); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function immutable(value) { return Object.freeze(JSON.parse(JSON.stringify(value))); }

export function founderReferenceStyleStagingEnabled() {
  return process.env.FOUNDER_REFERENCE_STYLE_STAGING_ENABLED === "true";
}

function validateAsset(value, role) {
  const expected = FOUNDER_REFERENCE_STYLE_ASSETS[role];
  if (!plain(value) || value.id !== expected.id || value.key !== expected.key || value.type !== "video/mp4" || !sha256.test(value.sha256 || "")) fail(`${role} asset identity`);
  if (!Number.isFinite(value.size) || value.size <= 0 || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 600) fail(`${role} media limits`);
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 320 || value.height < 180 || value.width > 3840 || value.height > 2160) fail(`${role} dimensions`);
  if (role === "source" && value.hasAudio !== true) fail("source audio requirement");
  return { id: value.id, key: value.key, type: value.type, sha256: value.sha256, size: value.size, duration: value.duration, width: value.width, height: value.height, hasAudio: Boolean(value.hasAudio) };
}

export function validateFounderReferenceStyleProfile(value, referenceAsset) {
  if (!plain(value) || value.version !== "founder-reference-style-profile/1" || value.id !== FOUNDER_REFERENCE_STYLE_ASSETS.profile.id || value.referenceAssetId !== referenceAsset.id || value.referenceSha256 !== referenceAsset.sha256) fail("profile identity");
  if (!plain(value.observation) || !warmth.has(value.observation.warmth) || !saturation.has(value.observation.saturation) || !contrast.has(value.observation.contrast) || !typography.has(value.observation.typography) || !animation.has(value.observation.animation) || !Array.isArray(value.observation.uncertainty)) fail("profile observation");
  if (!plain(value.colour) || !confidence.has(value.colour.confidence) || !Array.isArray(value.colour.limitations)) fail("profile colour evidence");
  const treatment = createCanonicalReferenceStyleTreatment(value.colour.treatment);
  return immutable({ version: value.version, id: value.id, referenceAssetId: value.referenceAssetId, referenceSha256: value.referenceSha256, observation: { ...value.observation, uncertainty: value.observation.uncertainty.slice(0, 6).map(String) }, colour: { treatment, confidence: value.colour.confidence, limitations: value.colour.limitations.slice(0, 6).map(String) }, typography: { enabled: value.observation.typography !== "none", treatment: value.observation.animation, confidence: value.typography?.confidence && confidence.has(value.typography.confidence) ? value.typography.confidence : "low", limitations: Array.isArray(value.typography?.limitations) ? value.typography.limitations.slice(0, 6).map(String) : ["Typography is generic creator-supplied treatment, not frame-accurate reference matching."] } });
}

/** Only the private staging-ingestion command may create this manifest. */
export function validateFounderReferenceStyleManifest(value) {
  if (!plain(value) || value.version !== FOUNDER_REFERENCE_STYLE_STAGING_VERSION) fail("manifest version");
  const reference = validateAsset(value.reference, "reference");
  const source = validateAsset(value.source, "source");
  const profile = validateFounderReferenceStyleProfile(value.profile, reference);
  return immutable({ version: value.version, reference, source, profile });
}

export function createFounderStyleProfileFromObservations({ referenceAsset, observations }) {
  const reference = validateAsset(referenceAsset, "reference");
  const referenceObservation = observations?.reference;
  const sourceObservation = observations?.source;
  if (!plain(referenceObservation) || !plain(sourceObservation) || !warmth.has(referenceObservation.warmth) || !saturation.has(referenceObservation.saturation) || !contrast.has(referenceObservation.contrast) || !typography.has(referenceObservation.typography) || !animation.has(referenceObservation.animation)) fail("validated Gemini observations");
  const recipe = {
    brightness: referenceObservation.warmth === "cool" ? -0.006 : 0,
    contrast: referenceObservation.contrast === "high" ? 0.06 : referenceObservation.contrast === "low" ? -0.025 : 0.025,
    saturation: referenceObservation.saturation === "low" ? -0.045 : referenceObservation.saturation === "high" ? 0.035 : 0,
    temperature: referenceObservation.warmth === "cool" ? -0.035 : referenceObservation.warmth === "warm" ? 0.028 : 0,
    tint: referenceObservation.warmth === "cool" ? -0.012 : 0,
    shadows: -0.012, highlights: -0.018, vibrance: referenceObservation.saturation === "low" ? 0.025 : 0,
    shadowTemperature: referenceObservation.warmth === "cool" ? -0.014 : 0,
    midtoneTemperature: referenceObservation.warmth === "cool" ? -0.02 : 0,
    highlightTemperature: referenceObservation.warmth === "cool" ? -0.01 : 0
  };
  return validateFounderReferenceStyleProfile({
    version: "founder-reference-style-profile/1", id: FOUNDER_REFERENCE_STYLE_ASSETS.profile.id,
    referenceAssetId: reference.id, referenceSha256: reference.sha256,
    observation: { warmth: referenceObservation.warmth, saturation: referenceObservation.saturation, contrast: referenceObservation.contrast, typography: referenceObservation.typography, animation: referenceObservation.animation, uncertainty: [...(referenceObservation.uncertainty || []), ...(sourceObservation.uncertainty || [])].slice(0, 6) },
    colour: { treatment: { version: 2, recipe }, confidence: "medium", limitations: ["Global source-aware adaptation only; no subject masking or scene-specific grade."] },
    typography: { confidence: "low", limitations: ["Reference observations did not establish exact fonts or frame-accurate animation timing."] }
  }, reference);
}

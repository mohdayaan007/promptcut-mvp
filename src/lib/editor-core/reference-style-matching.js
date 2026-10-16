import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { buildReferenceStyleTreatmentFilters } from "@/lib/editor-core/edit-executor";

export const REFERENCE_STYLE_SAFE_ERROR = "This reference can’t be used for style matching. Please choose another image or video.";
export const REFERENCE_STYLE_COHERENCE_ERROR = "This first version works best with visually coherent footage. Please choose another video.";

export class ReferenceStyleError extends Error {
  constructor(reason, message = "This reference style could not be applied safely.") { super(message); this.name = "ReferenceStyleError"; this.reason = reason; }
}

const DIRECTIONS = Object.freeze(["lower", "preserve", "raise"]);
const LEVELS = Object.freeze(["low", "medium", "high"]);
const INTENSITIES = Object.freeze(["subtle", "standard", "strong"]);
const AMBIENT_COLOR_CHARACTERS = Object.freeze(["neutral", "warm_golden", "cool_mint", "cool_clean"]);
const HIGHLIGHT_CHARACTERS = Object.freeze(["natural", "soft", "flash"]);
const COLOR_SEPARATIONS = Object.freeze(["neutral", "rich_controlled", "editorial"]);
const OBSERVED_CONTEXTS = Object.freeze(["portrait", "lifestyle", "landscape", "architecture", "food", "product", "night", "mixed"]);

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function enumValue(value, values, field) { if (!values.includes(value)) throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE", `Invalid ${field}`); return value; }

/** Strictly validates bounded categorical facts; model prose never reaches FFmpeg. */
export function validateReferenceStyleAnalysis(value) {
  if (!object(value) || typeof value.safe !== "boolean") throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE");
  if (!value.safe) throw new ReferenceStyleError("REFERENCE_SAFETY_REJECTED", REFERENCE_STYLE_SAFE_ERROR);
  if (!object(value.reference) || !object(value.target) || !object(value.treatment)) throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE");
  const treatment = value.treatment;
  return Object.freeze({
    reference: Object.freeze({ context: enumValue(value.reference.context, OBSERVED_CONTEXTS, "reference context"), peopleOrSkin: Boolean(value.reference.peopleOrSkin), exposure: enumValue(value.reference.exposure, LEVELS, "reference exposure"), saturation: enumValue(value.reference.saturation, LEVELS, "reference saturation"), warmth: enumValue(value.reference.warmth, ["cool", "neutral", "warm"], "reference warmth") }),
    target: Object.freeze({ context: enumValue(value.target.context, OBSERVED_CONTEXTS, "target context"), coherent: Boolean(value.target.coherent), peopleOrSkin: Boolean(value.target.peopleOrSkin), exposure: enumValue(value.target.exposure, LEVELS, "target exposure"), saturation: enumValue(value.target.saturation, LEVELS, "target saturation"), warmth: enumValue(value.target.warmth, ["cool", "neutral", "warm"], "target warmth"), compatible: Boolean(value.target.compatible) }),
    treatment: Object.freeze({
      exposure: enumValue(treatment.exposure, DIRECTIONS, "treatment exposure"), exposureIntensity: enumValue(treatment.exposureIntensity || "standard", INTENSITIES, "treatment exposure intensity"),
      contrast: enumValue(treatment.contrast, DIRECTIONS, "treatment contrast"), contrastIntensity: enumValue(treatment.contrastIntensity || "standard", INTENSITIES, "treatment contrast intensity"),
      blacks: enumValue(treatment.blacks, DIRECTIONS, "treatment blacks"), blackIntensity: enumValue(treatment.blackIntensity || "standard", INTENSITIES, "treatment black intensity"),
      highlights: enumValue(treatment.highlights, DIRECTIONS, "treatment highlights"), highlightIntensity: enumValue(treatment.highlightIntensity || "standard", INTENSITIES, "treatment highlight intensity"),
      color: enumValue(treatment.color, DIRECTIONS, "treatment color"), colorIntensity: enumValue(treatment.colorIntensity || "standard", INTENSITIES, "treatment color intensity"),
      warmth: enumValue(treatment.warmth, ["cool", "neutral", "warm"], "treatment warmth"), warmthIntensity: enumValue(treatment.warmthIntensity || "standard", INTENSITIES, "treatment warmth intensity"),
      ambientColorCharacter: enumValue(treatment.ambientColorCharacter || "neutral", AMBIENT_COLOR_CHARACTERS, "ambient color character"),
      highlightCharacter: enumValue(treatment.highlightCharacter || "natural", HIGHLIGHT_CHARACTERS, "highlight character"),
      colorSeparation: enumValue(treatment.colorSeparation || "neutral", COLOR_SEPARATIONS, "color separation"),
      mood: enumValue(treatment.mood, ["natural", "soft", "rich", "moody", "luminous"], "treatment mood")
    })
  });
}

const direction = (value, amount) => value === "raise" ? amount : value === "lower" ? -amount : 0;
const intensity = (value, values) => values[INTENSITIES.indexOf(value)] ?? values[1];
const bounded = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));

/** Server-owned conservative mapping, with deterministic target headroom protection. */
export function deriveReferenceStyleTreatment({ analysis, metrics }) {
  const safe = validateReferenceStyleAnalysis(analysis);
  if (!safe.target.coherent) throw new ReferenceStyleError("REFERENCE_TARGET_HETEROGENEOUS", REFERENCE_STYLE_COHERENCE_ERROR);
  if (!safe.target.compatible) throw new ReferenceStyleError("REFERENCE_COMPATIBILITY_WEAK", "This reference is not a safe match for this video.");
  if (!object(metrics)) throw new ReferenceStyleError("REFERENCE_TREATMENT_DERIVATION_FAILED");
  // A strong combined exposure/contrast move can clip a warm skin highlight
  // well before code-white. p95 catches a broadly bright frame and p99 catches
  // small bright face/practical-light areas. This constrains only the
  // highlight-risky axes; color separation and non-highlight tonal treatment
  // retain their authority.
  const highToneRisk = metrics.lumaP95 >= 0.85 || (Number.isFinite(metrics.lumaP99) && metrics.lumaP99 >= 0.94);
  const brightHeadroom = metrics.lumaP95 < 0.91 && metrics.nearWhiteFraction < 0.03 && !highToneRisk;
  const limitedHighlights = metrics.lumaP95 >= 0.91 || metrics.nearWhiteFraction >= 0.03 || highToneRisk;
  const shadowHeadroom = metrics.lumaP05 > 0.035 && metrics.nearBlackFraction < 0.08;
  const saturated = metrics.saturationIndex > 0.62 || safe.target.saturation === "high";
  const skin = safe.target.peopleOrSkin || safe.reference.peopleOrSkin;
  const editorial = safe.treatment.colorSeparation === "editorial";
  const richColor = safe.treatment.colorSeparation === "rich_controlled";
  const exposureAmount = intensity(safe.treatment.exposureIntensity, [0.09, 0.17, 0.25]);
  const contrastAmount = intensity(safe.treatment.contrastIntensity, [0.1, 0.19, 0.29]);
  const colorAmount = intensity(safe.treatment.colorIntensity, [0.08, 0.16, 0.26]);
  const colorAuthority = saturated ? Math.min(colorAmount, 0.11) : colorAmount;
  const warmthAmount = intensity(safe.treatment.warmthIntensity, [0.07, 0.13, 0.2]);
  const ambient = safe.treatment.ambientColorCharacter;
  const ambientTemperature = ambient === "warm_golden" ? warmthAmount : ambient === "cool_mint" ? -warmthAmount : ambient === "cool_clean" ? -warmthAmount * 0.8 : safe.treatment.warmth === "warm" ? warmthAmount : safe.treatment.warmth === "cool" ? -warmthAmount : 0;
  const ambientTint = ambient === "cool_mint" ? -intensity(safe.treatment.colorIntensity, [0.035, 0.065, 0.1]) : 0;
  // Skin constrains only hue/chroma authority. Tonal structure remains available
  // so a human target can still inherit a reference's photographic character.
  const skinHueCap = skin ? 0.12 : 0.2;
  const skinTintCap = skin ? 0.055 : 0.1;
  const highlightSafeContrast = highToneRisk ? Math.min(contrastAmount, 0.1) : contrastAmount;
  const recipe = {
    brightness: direction(safe.treatment.exposure, brightHeadroom ? exposureAmount : Math.min(exposureAmount, 0.07)),
    contrast: direction(safe.treatment.contrast, highlightSafeContrast),
    saturation: direction(safe.treatment.color, colorAuthority),
    temperature: bounded(ambientTemperature, -skinHueCap, skinHueCap),
    tint: bounded(ambientTint, -skinTintCap, skinTintCap),
    shadows: safe.treatment.blacks === "raise" ? intensity(safe.treatment.blackIntensity, [0.07, 0.13, 0.2]) : safe.treatment.blacks === "lower" && shadowHeadroom ? -intensity(safe.treatment.blackIntensity, [0.05, 0.1, 0.16]) : 0,
    highlights: safe.treatment.highlightCharacter === "flash" && !limitedHighlights ? intensity(safe.treatment.highlightIntensity, [0.08, 0.15, 0.22]) : safe.treatment.highlights === "lower" ? -intensity(safe.treatment.highlightIntensity, [0.08, 0.15, 0.23]) : safe.treatment.highlights === "raise" && brightHeadroom ? intensity(safe.treatment.highlightIntensity, [0.06, 0.11, 0.18]) : 0,
    vibrance: safe.treatment.color === "raise" ? (saturated ? Math.min(colorAuthority, 0.09) : colorAuthority + (editorial ? 0.1 : richColor ? 0.05 : 0)) : safe.treatment.color === "lower" ? -0.08 : editorial ? 0.08 : 0,
    blackLift: safe.treatment.blacks === "raise" ? intensity(safe.treatment.blackIntensity, [0.1, 0.18, 0.28]) : safe.treatment.blacks === "lower" && shadowHeadroom ? -intensity(safe.treatment.blackIntensity, [0.08, 0.14, 0.22]) : 0,
    midtoneGamma: safe.treatment.exposure === "raise" && brightHeadroom ? intensity(safe.treatment.exposureIntensity, [0.06, 0.11, 0.16]) : safe.treatment.exposure === "lower" && shadowHeadroom ? -0.08 : safe.treatment.highlightCharacter === "flash" && brightHeadroom ? 0.07 : 0
  };
  return createCanonicalReferenceStyleTreatment({ version: 1, recipe });
}

/** Log only bounded categories, server metrics, recipes and compiled filters. */
export function createReferenceStyleDiagnostic({ jobId, analysis, metrics, treatment }) {
  const safe = validateReferenceStyleAnalysis(analysis);
  const canonical = createCanonicalReferenceStyleTreatment(treatment);
  return Object.freeze({ jobId, reference: safe.reference, target: safe.target, treatmentIntent: safe.treatment, metrics, recipe: canonical.recipe, filters: buildReferenceStyleTreatmentFilters(canonical.recipe) });
}

export function requestsReferenceStyleMatch(prompt = "", hasReference = false) {
  return Boolean(hasReference && /\b(?:make|match|use|give)\b[\s\S]{0,80}\b(?:look like this|this style|reference (?:style|look)|style reference|same look)\b/i.test(prompt));
}

export function referenceStyleAnalysisSchema() {
  const level = { type: "string", enum: LEVELS };
  const directionSchema = { type: "string", enum: DIRECTIONS };
  return { type: "object", properties: {
    safe: { type: "boolean" },
    reference: { type: "object", properties: { context: { type: "string", enum: OBSERVED_CONTEXTS }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] } }, required: ["context", "peopleOrSkin", "exposure", "saturation", "warmth"], additionalProperties: false },
    target: { type: "object", properties: { context: { type: "string", enum: OBSERVED_CONTEXTS }, coherent: { type: "boolean" }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, compatible: { type: "boolean" } }, required: ["context", "coherent", "peopleOrSkin", "exposure", "saturation", "warmth", "compatible"], additionalProperties: false },
    treatment: { type: "object", properties: { exposure: directionSchema, exposureIntensity: { type: "string", enum: INTENSITIES }, contrast: directionSchema, contrastIntensity: { type: "string", enum: INTENSITIES }, blacks: directionSchema, blackIntensity: { type: "string", enum: INTENSITIES }, highlights: directionSchema, highlightIntensity: { type: "string", enum: INTENSITIES }, color: directionSchema, colorIntensity: { type: "string", enum: INTENSITIES }, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, warmthIntensity: { type: "string", enum: INTENSITIES }, ambientColorCharacter: { type: "string", enum: AMBIENT_COLOR_CHARACTERS }, highlightCharacter: { type: "string", enum: HIGHLIGHT_CHARACTERS }, colorSeparation: { type: "string", enum: COLOR_SEPARATIONS }, mood: { type: "string", enum: ["natural", "soft", "rich", "moody", "luminous"] } }, required: ["exposure", "exposureIntensity", "contrast", "contrastIntensity", "blacks", "blackIntensity", "highlights", "highlightIntensity", "color", "colorIntensity", "warmth", "warmthIntensity", "ambientColorCharacter", "highlightCharacter", "colorSeparation", "mood"], additionalProperties: false }
  }, required: ["safe", "reference", "target", "treatment"], additionalProperties: false };
}

export function referenceSafetySchema() {
  return { type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"], additionalProperties: false };
}

export function buildReferenceStyleAnalysisPrompt({ metrics }) {
  return [
    "You assess whether a supplied reference image can safely guide photographic color treatment for supplied target video frames. Do not create an edit plan or return numeric controls, filters, LUTs, paths, or prose.",
    "Reject only clearly high-risk explicit sexual content, sexual content involving minors, sexual violence, or extreme graphic gore. Ordinary portraits, fashion, swimwear, kissing, and lifestyle scenes are safe.",
    "Separate scene facts from treatment. Never copy reference objects into the target, but preserve broad photographic relationships through ambient color character, highlight character, and color separation. Use strong only for genuinely clear editorial/flash/color direction. Return the bounded categorical schema only.",
    `Server-measured target metrics: ${JSON.stringify(metrics)}`
  ].join("\n\n");
}

function safeStatus(error) { return Number(error?.status || error?.statusCode || error?.code || error?.$metadata?.httpStatusCode); }
function transient(error) { const status = safeStatus(error); return status === 429 || status === 503 || status >= 500 && status < 600; }

async function generate(ai, request) {
  let caught;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await ai.models.generateContent(request); }
    catch (error) { caught = error; if (!transient(error) || attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt))); }
  }
  throw caught;
}

/** Uploads only job-scratch assets, deletes every Gemini file in finally, and returns no URI. */
export async function analyzeReferenceStyle({ referencePath, referenceMimeType, targetFrames, metrics, aiClient }) {
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const uploaded = [];
  try {
    const reference = await ai.files.upload({ file: referencePath, config: { mimeType: referenceMimeType } });
    uploaded.push(reference);
    let safety;
    try {
      const response = await generate(ai, { model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: [createPartFromUri(reference.uri, reference.mimeType || referenceMimeType), "Is this reference safe for photographic style matching? Reject only explicit sexual acts/pornography, sexual content involving minors, sexual violence, or extreme graphic gore. Ordinary fashion, swimwear, kissing, portraits, and lifestyle are safe. Return JSON only."], config: { responseMimeType: "application/json", responseJsonSchema: referenceSafetySchema() } });
      safety = JSON.parse(response.text || "");
    } catch (error) {
      if (error instanceof SyntaxError) throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE");
      throw new ReferenceStyleError("REFERENCE_ANALYSIS_FAILED");
    }
    if (safety?.safe !== true) throw new ReferenceStyleError("REFERENCE_SAFETY_REJECTED", REFERENCE_STYLE_SAFE_ERROR);
    const targets = [];
    for (const frame of targetFrames) {
      const uploadedFrame = await ai.files.upload({ file: frame.imagePath, config: { mimeType: "image/jpeg" } });
      uploaded.push(uploadedFrame); targets.push(uploadedFrame);
    }
    let response;
    try {
      response = await generate(ai, { model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: ["REFERENCE IMAGE", createPartFromUri(reference.uri, reference.mimeType || referenceMimeType), ...targets.flatMap((file, index) => [`TARGET FRAME ${index + 1}`, createPartFromUri(file.uri, file.mimeType || "image/jpeg")]), buildReferenceStyleAnalysisPrompt({ metrics })], config: { responseMimeType: "application/json", responseJsonSchema: referenceStyleAnalysisSchema() } });
    } catch { throw new ReferenceStyleError("REFERENCE_ANALYSIS_FAILED"); }
    try { return { analysis: validateReferenceStyleAnalysis(JSON.parse(response.text || "")), treatment: deriveReferenceStyleTreatment({ analysis: JSON.parse(response.text || ""), metrics }) }; }
    catch (error) { if (error instanceof ReferenceStyleError) throw error; throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE"); }
  } finally {
    await Promise.all(uploaded.map((file) => file?.name ? ai.files.delete({ name: file.name }).catch(() => {}) : null));
  }
}

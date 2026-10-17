import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { buildReferenceStyleTreatmentFilters } from "@/lib/editor-core/edit-executor";

export const REFERENCE_STYLE_SAFE_ERROR = "This reference can’t be used for style matching. Please choose another image or video.";
export const REFERENCE_STYLE_COHERENCE_ERROR = "This first version works best with visually coherent footage. Please choose another video.";

export class ReferenceStyleError extends Error {
  constructor(reason, message = "This reference style could not be applied safely.", field = null) {
    super(message);
    this.name = "ReferenceStyleError";
    this.reason = reason;
    this.field = field;
  }
}

const DIRECTIONS = Object.freeze(["lower", "preserve", "raise"]);
const LEVELS = Object.freeze(["low", "medium", "high"]);
const INTENSITIES = Object.freeze(["subtle", "standard", "strong"]);
const AMBIENT_COLOR_CHARACTERS = Object.freeze(["neutral", "warm_golden", "cool_mint", "cool_clean"]);
const DOMINANT_COLOR_BIASES = Object.freeze(["neutral", "yellow_orange", "green_mint", "cyan_blue", "mixed"]);
const HIGHLIGHT_CHARACTERS = Object.freeze(["natural", "soft", "flash"]);
const BLACK_CHARACTERS = Object.freeze(["lifted", "neutral", "deep"]);
const SATURATION_CHARACTERS = Object.freeze(["muted", "natural", "rich"]);
const COLOR_SEPARATIONS = Object.freeze(["neutral", "rich_controlled", "editorial"]);
const OBSERVED_CONTEXTS = Object.freeze(["portrait", "lifestyle", "landscape", "architecture", "food", "product", "night", "mixed"]);
const REFERENCE_ANALYSIS_VERSION = 1;
const TARGET_ANALYSIS_VERSION = 1;

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function invalidModelField(field) { throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE", `Invalid ${field}`, field); }
function enumValue(value, values, field) { if (!values.includes(value)) invalidModelField(field); return value; }
function optionalEnumValue(value, fallback, values, field) { return value === undefined ? fallback : enumValue(value, values, field); }
function booleanValue(value, field) { if (typeof value !== "boolean") invalidModelField(field); return value; }
function exactObject(value, fields, field) {
  if (!object(value)) invalidModelField(field);
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalidModelField(`${field}.${key}`);
  return value;
}

function signature(value, field, { target = false } = {}) {
  const fields = ["context", ...(target ? ["coherent"] : []), "peopleOrSkin", "exposure", "saturation", "warmth", "ambientColorCharacter", "dominantColorBias", "highlightCharacter", "blackCharacter", "saturationCharacter", "colorSeparation", ...(target ? ["compatible"] : [])];
  const observed = exactObject(value, fields, field);
  const warmth = enumValue(observed.warmth, ["cool", "neutral", "warm"], `${field} warmth`);
  const saturation = enumValue(observed.saturation, LEVELS, `${field} saturation`);
  // The signature fields below are deliberately optional for compatibility with
  // already-issued model responses. Their conservative defaults never invent a
  // treatment direction; future B2 signatures should provide them explicitly.
  const ambientColorCharacter = optionalEnumValue(
    observed.ambientColorCharacter,
    warmth === "warm" ? "warm_golden" : warmth === "cool" ? "cool_clean" : "neutral",
    AMBIENT_COLOR_CHARACTERS,
    `${field} ambient color character`
  );
  const dominantColorBias = optionalEnumValue(
    observed.dominantColorBias,
    warmth === "warm" ? "yellow_orange" : warmth === "cool" ? "cyan_blue" : "neutral",
    DOMINANT_COLOR_BIASES,
    `${field} dominant color bias`
  );
  const saturationCharacter = optionalEnumValue(
    observed.saturationCharacter,
    saturation === "low" ? "muted" : saturation === "high" ? "rich" : "natural",
    SATURATION_CHARACTERS,
    `${field} saturation character`
  );
  return Object.freeze({
    context: optionalEnumValue(observed.context, "mixed", OBSERVED_CONTEXTS, `${field} context`),
    ...(target ? { coherent: booleanValue(observed.coherent, `${field} coherent`) } : {}),
    peopleOrSkin: booleanValue(observed.peopleOrSkin, `${field} peopleOrSkin`),
    exposure: enumValue(observed.exposure, LEVELS, `${field} exposure`),
    saturation,
    warmth,
    ambientColorCharacter,
    dominantColorBias,
    highlightCharacter: optionalEnumValue(observed.highlightCharacter, "natural", HIGHLIGHT_CHARACTERS, `${field} highlight character`),
    blackCharacter: optionalEnumValue(observed.blackCharacter, "neutral", BLACK_CHARACTERS, `${field} black character`),
    saturationCharacter,
    colorSeparation: optionalEnumValue(observed.colorSeparation, "neutral", COLOR_SEPARATIONS, `${field} color separation`),
    // Content compatibility is diagnostic-only. A portrait reference can safely
    // guide tone and color for architecture or landscape footage.
    ...(target ? { compatible: booleanValue(observed.compatible, `${field} compatible`) } : {})
  });
}

export function validateReferenceStyleReferenceSignature(value) {
  return signature(value, "reference");
}

export function validateReferenceStyleTargetSignature(value) {
  return signature(value, "target", { target: true });
}

/** Strictly validates bounded categorical facts; model prose never reaches FFmpeg. */
export function validateReferenceStyleAnalysis(value) {
  exactObject(value, ["safe", "reference", "target", "treatment"], "analysis");
  if (typeof value.safe !== "boolean") invalidModelField("safe");
  if (!value.safe) throw new ReferenceStyleError("REFERENCE_SAFETY_REJECTED", REFERENCE_STYLE_SAFE_ERROR);
  const reference = validateReferenceStyleReferenceSignature(value.reference);
  const target = validateReferenceStyleTargetSignature(value.target);
  // `treatment` is accepted only for compatibility with previously mocked
  // responses. It is never model authority; production schema requests omit it.
  const treatment = value.treatment === undefined ? undefined : exactObject(value.treatment, ["exposure", "exposureIntensity", "contrast", "contrastIntensity", "blacks", "blackIntensity", "highlights", "highlightIntensity", "color", "colorIntensity", "warmth", "warmthIntensity", "ambientColorCharacter", "highlightCharacter", "colorSeparation", "mood"], "treatment");
  return Object.freeze({
    safe: true,
    reference,
    target,
    ...(treatment ? { treatment: Object.freeze({
      exposure: enumValue(treatment.exposure, DIRECTIONS, "treatment exposure"), exposureIntensity: optionalEnumValue(treatment.exposureIntensity, "standard", INTENSITIES, "treatment exposure intensity"),
      contrast: enumValue(treatment.contrast, DIRECTIONS, "treatment contrast"), contrastIntensity: optionalEnumValue(treatment.contrastIntensity, "standard", INTENSITIES, "treatment contrast intensity"),
      blacks: enumValue(treatment.blacks, DIRECTIONS, "treatment blacks"), blackIntensity: optionalEnumValue(treatment.blackIntensity, "standard", INTENSITIES, "treatment black intensity"),
      highlights: enumValue(treatment.highlights, DIRECTIONS, "treatment highlights"), highlightIntensity: optionalEnumValue(treatment.highlightIntensity, "standard", INTENSITIES, "treatment highlight intensity"),
      color: enumValue(treatment.color, DIRECTIONS, "treatment color"), colorIntensity: optionalEnumValue(treatment.colorIntensity, "standard", INTENSITIES, "treatment color intensity"),
      warmth: enumValue(treatment.warmth, ["cool", "neutral", "warm"], "treatment warmth"), warmthIntensity: optionalEnumValue(treatment.warmthIntensity, "standard", INTENSITIES, "treatment warmth intensity"),
      ambientColorCharacter: optionalEnumValue(treatment.ambientColorCharacter, "neutral", AMBIENT_COLOR_CHARACTERS, "ambient color character"),
      highlightCharacter: optionalEnumValue(treatment.highlightCharacter, "natural", HIGHLIGHT_CHARACTERS, "highlight character"),
      colorSeparation: optionalEnumValue(treatment.colorSeparation, "neutral", COLOR_SEPARATIONS, "color separation"),
      mood: optionalEnumValue(treatment.mood, "natural", ["natural", "soft", "rich", "moody", "luminous"], "treatment mood")
    }) } : {})
  });
}

const direction = (value, amount) => value === "raise" ? amount : value === "lower" ? -amount : 0;
const intensity = (value, values) => values[INTENSITIES.indexOf(value)] ?? values[1];
const bounded = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));

const rankedDifference = (reference, target, values) => values.indexOf(reference) - values.indexOf(target);
const directionFromDifference = (difference) => difference > 0 ? "raise" : difference < 0 ? "lower" : "preserve";
const directionalAmount = (difference, values) => intensity(Math.abs(difference) >= 2 ? "strong" : Math.abs(difference) === 1 ? "standard" : "subtle", values);

/**
 * Computes the bounded photographic intent from observed reference/target
 * signatures. Model treatment language remains diagnostic-only and can never
 * reverse a cool reference into a warm grade (or vice versa).
 */
export function deriveReferenceStyleDelta(analysis) {
  const safe = validateReferenceStyleAnalysis(analysis);
  const reference = safe.reference;
  const target = safe.target;
  const ambientDifference = rankedDifference(reference.ambientColorCharacter, target.ambientColorCharacter, ["cool_mint", "cool_clean", "neutral", "warm_golden"]);
  const warmthDifference = ambientDifference || rankedDifference(reference.warmth, target.warmth, ["cool", "neutral", "warm"]);
  const dominantDifference = rankedDifference(reference.dominantColorBias, target.dominantColorBias, ["cyan_blue", "green_mint", "neutral", "mixed", "yellow_orange"]);
  const colorDifference = rankedDifference(reference.saturationCharacter, target.saturationCharacter, ["muted", "natural", "rich"]);
  const blackDifference = rankedDifference(reference.blackCharacter, target.blackCharacter, ["deep", "neutral", "lifted"]);
  const highlightDifference = rankedDifference(reference.highlightCharacter, target.highlightCharacter, ["soft", "natural", "flash"]);
  const separationDifference = rankedDifference(reference.colorSeparation, target.colorSeparation, ["neutral", "rich_controlled", "editorial"]);
  const exposureDifference = rankedDifference(reference.exposure, target.exposure, LEVELS);
  return Object.freeze({
    exposure: directionFromDifference(exposureDifference),
    exposureDifference,
    contrast: directionFromDifference(highlightDifference || separationDifference),
    blacks: directionFromDifference(blackDifference),
    highlights: directionFromDifference(highlightDifference),
    color: directionFromDifference(colorDifference),
    warmth: directionFromDifference(warmthDifference),
    warmthDifference,
    ambientColorCharacter: reference.ambientColorCharacter,
    dominantColorBias: reference.dominantColorBias,
    tint: directionFromDifference(dominantDifference),
    colorSeparation: reference.colorSeparation,
    colorDifference,
    blackDifference,
    highlightDifference,
    separationDifference
  });
}

/** Server-owned conservative mapping, with deterministic target headroom protection. */
export function deriveReferenceStyleTreatment({ analysis, metrics }) {
  const safe = validateReferenceStyleAnalysis(analysis);
  if (!safe.target.coherent) throw new ReferenceStyleError("REFERENCE_TARGET_HETEROGENEOUS", REFERENCE_STYLE_COHERENCE_ERROR);
  if (!object(metrics)) throw new ReferenceStyleError("REFERENCE_TREATMENT_DERIVATION_FAILED");
  const delta = deriveReferenceStyleDelta(safe);
  // A strong combined exposure/contrast move can clip a warm skin highlight
  // well before code-white. p95 catches a broadly bright frame and p99 catches
  // small bright face/practical-light areas. This constrains only the
  // highlight-risky axes; color separation and non-highlight tonal treatment
  // retain their authority.
  const highToneRisk = metrics.lumaP95 >= 0.85 || (Number.isFinite(metrics.lumaP99) && metrics.lumaP99 >= 0.94);
  const brightHeadroom = metrics.lumaP95 < 0.91 && metrics.nearWhiteFraction < 0.03 && !highToneRisk;
  const limitedHighlights = metrics.lumaP95 >= 0.91 || metrics.nearWhiteFraction >= 0.03 || highToneRisk;
  const shadowHeadroom = metrics.lumaP05 > 0.035 && metrics.nearBlackFraction < 0.08;
  const saturated = metrics.saturationIndex > 0.62 || safe.target.saturationCharacter === "rich";
  const skin = safe.target.peopleOrSkin || safe.reference.peopleOrSkin;
  const editorial = delta.colorSeparation === "editorial";
  const richColor = delta.colorSeparation === "rich_controlled";
  const exposureAmount = directionalAmount(delta.exposureDifference, [0.08, 0.14, 0.2]);
  const contrastAmount = directionalAmount(delta.highlightDifference || delta.separationDifference, [0.08, 0.14, 0.22]);
  const colorAmount = directionalAmount(delta.colorDifference, [0.08, 0.14, 0.22]);
  const colorAuthority = saturated && delta.color === "raise" ? Math.min(colorAmount, 0.11) : colorAmount;
  const warmthAmount = directionalAmount(delta.warmthDifference, [0.07, 0.13, 0.18]);
  const ambientTemperature = direction(delta.warmth, warmthAmount);
  const tintAmount = delta.dominantColorBias === "green_mint" ? 0.065 : delta.dominantColorBias === "cyan_blue" || delta.dominantColorBias === "yellow_orange" ? 0.035 : 0;
  const ambientTint = delta.dominantColorBias === "green_mint" || delta.dominantColorBias === "cyan_blue" ? -tintAmount : delta.dominantColorBias === "yellow_orange" ? tintAmount : 0;
  // Skin constrains only hue/chroma authority. Tonal structure remains available
  // so a human target can still inherit a reference's photographic character.
  const skinHueCap = skin ? 0.12 : 0.2;
  const skinTintCap = skin ? 0.055 : 0.1;
  const highlightSafeContrast = highToneRisk ? Math.min(contrastAmount, 0.1) : contrastAmount;
  const recipe = {
    brightness: direction(delta.exposure, brightHeadroom ? exposureAmount : Math.min(exposureAmount, 0.07)),
    contrast: direction(delta.contrast, highlightSafeContrast),
    saturation: direction(delta.color, colorAuthority),
    temperature: bounded(ambientTemperature, -skinHueCap, skinHueCap),
    tint: bounded(ambientTint, -skinTintCap, skinTintCap),
    shadows: delta.blacks === "raise" ? directionalAmount(delta.blackDifference, [0.07, 0.13, 0.2]) : delta.blacks === "lower" && shadowHeadroom ? -directionalAmount(delta.blackDifference, [0.05, 0.1, 0.16]) : 0,
    highlights: delta.highlights === "raise" && !limitedHighlights ? directionalAmount(delta.highlightDifference, [0.08, 0.15, 0.22]) : delta.highlights === "lower" ? -directionalAmount(delta.highlightDifference, [0.08, 0.15, 0.23]) : 0,
    vibrance: delta.color === "raise" ? (saturated ? Math.min(colorAuthority, 0.09) : colorAuthority + (editorial ? 0.1 : richColor ? 0.05 : 0)) : delta.color === "lower" ? -0.08 : editorial ? 0.08 : 0,
    blackLift: delta.blacks === "raise" ? directionalAmount(delta.blackDifference, [0.1, 0.18, 0.28]) : delta.blacks === "lower" && shadowHeadroom ? -directionalAmount(delta.blackDifference, [0.08, 0.14, 0.22]) : 0,
    midtoneGamma: delta.exposure === "raise" && brightHeadroom ? directionalAmount(delta.exposureDifference, [0.06, 0.11, 0.16]) : delta.exposure === "lower" && shadowHeadroom ? -0.08 : delta.highlights === "raise" && brightHeadroom ? 0.07 : 0
  };
  return createCanonicalReferenceStyleTreatment({ version: 1, recipe });
}

/** Log only bounded categories, server metrics, recipes and compiled filters. */
export function createReferenceStyleDiagnostic({ jobId, analysis, metrics, treatment }) {
  const safe = validateReferenceStyleAnalysis(analysis);
  const canonical = createCanonicalReferenceStyleTreatment(treatment);
  const derivedDelta = deriveReferenceStyleDelta(safe);
  return Object.freeze({ jobId, referenceAnalysisVersion: REFERENCE_ANALYSIS_VERSION, targetAnalysisVersion: TARGET_ANALYSIS_VERSION, referenceSignature: safe.reference, targetSignature: safe.target, derivedDelta, finalTreatmentIntent: derivedDelta, metrics, recipe: canonical.recipe, filters: buildReferenceStyleTreatmentFilters(canonical.recipe) });
}

/** Safe worker diagnostic: it intentionally drops model text and media metadata. */
export function createReferenceStyleFailureDiagnostic({ jobId, error }) {
  if (!(error instanceof ReferenceStyleError)) return Object.freeze({ jobId, stage: "reference_style_analysis", reason: "REFERENCE_ANALYSIS_FAILED" });
  return Object.freeze({
    jobId,
    stage: "reference_style_analysis",
    reason: error.reason,
    ...(error.field ? { field: error.field } : {})
  });
}

export function requestsReferenceStyleMatch(prompt = "", hasReference = false) {
  return Boolean(hasReference && /\b(?:make|match|use|give)\b[\s\S]{0,80}\b(?:look like this|this style|reference (?:style|look)|style reference|same look)\b/i.test(prompt));
}

export function referenceStyleAnalysisSchema() {
  const level = { type: "string", enum: LEVELS };
  return { type: "object", properties: {
    safe: { type: "boolean" },
    reference: { type: "object", properties: { context: { type: "string", enum: OBSERVED_CONTEXTS }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, ambientColorCharacter: { type: "string", enum: AMBIENT_COLOR_CHARACTERS }, dominantColorBias: { type: "string", enum: DOMINANT_COLOR_BIASES }, highlightCharacter: { type: "string", enum: HIGHLIGHT_CHARACTERS }, blackCharacter: { type: "string", enum: BLACK_CHARACTERS }, saturationCharacter: { type: "string", enum: SATURATION_CHARACTERS }, colorSeparation: { type: "string", enum: COLOR_SEPARATIONS } }, required: ["peopleOrSkin", "exposure", "saturation", "warmth", "ambientColorCharacter", "dominantColorBias", "highlightCharacter", "blackCharacter", "saturationCharacter", "colorSeparation"], additionalProperties: false },
    target: { type: "object", properties: { context: { type: "string", enum: OBSERVED_CONTEXTS }, coherent: { type: "boolean" }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, ambientColorCharacter: { type: "string", enum: AMBIENT_COLOR_CHARACTERS }, dominantColorBias: { type: "string", enum: DOMINANT_COLOR_BIASES }, highlightCharacter: { type: "string", enum: HIGHLIGHT_CHARACTERS }, blackCharacter: { type: "string", enum: BLACK_CHARACTERS }, saturationCharacter: { type: "string", enum: SATURATION_CHARACTERS }, colorSeparation: { type: "string", enum: COLOR_SEPARATIONS }, compatible: { type: "boolean" } }, required: ["coherent", "peopleOrSkin", "exposure", "saturation", "warmth", "ambientColorCharacter", "dominantColorBias", "highlightCharacter", "blackCharacter", "saturationCharacter", "colorSeparation", "compatible"], additionalProperties: false }
  }, required: ["safe", "reference", "target"], additionalProperties: false };
}

function referenceSignatureSchema() {
  const level = { type: "string", enum: LEVELS };
  return { type: "object", properties: {
    context: { type: "string", enum: OBSERVED_CONTEXTS }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level,
    warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, ambientColorCharacter: { type: "string", enum: AMBIENT_COLOR_CHARACTERS },
    dominantColorBias: { type: "string", enum: DOMINANT_COLOR_BIASES }, highlightCharacter: { type: "string", enum: HIGHLIGHT_CHARACTERS },
    blackCharacter: { type: "string", enum: BLACK_CHARACTERS }, saturationCharacter: { type: "string", enum: SATURATION_CHARACTERS }, colorSeparation: { type: "string", enum: COLOR_SEPARATIONS }
  }, required: ["peopleOrSkin", "exposure", "saturation", "warmth", "ambientColorCharacter", "dominantColorBias", "highlightCharacter", "blackCharacter", "saturationCharacter", "colorSeparation"], additionalProperties: false };
}

export function referenceStyleReferenceAnalysisSchema() {
  return referenceSignatureSchema();
}

export function referenceStyleTargetAnalysisSchema() {
  return { ...referenceSignatureSchema(), properties: {
    ...referenceSignatureSchema().properties,
    coherent: { type: "boolean" }, compatible: { type: "boolean" }
  }, required: ["coherent", "peopleOrSkin", "exposure", "saturation", "warmth", "ambientColorCharacter", "dominantColorBias", "highlightCharacter", "blackCharacter", "saturationCharacter", "colorSeparation", "compatible"] };
}

export function referenceSafetySchema() {
  return { type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"], additionalProperties: false };
}

export function buildReferenceStyleReferenceAnalysisPrompt() {
  return [
    "Classify only the supplied reference image's bounded photographic signature. Do not create an edit plan or return numeric controls, filters, LUTs, paths, treatment advice, or prose.",
    "Return only the schema: peopleOrSkin; exposure and saturation as low, medium, or high; warmth as cool, neutral, or warm; ambientColorCharacter (neutral, warm_golden, cool_mint, cool_clean); dominantColorBias (neutral, yellow_orange, green_mint, cyan_blue, mixed); highlightCharacter (natural, soft, flash); blackCharacter (lifted, neutral, deep); saturationCharacter (muted, natural, rich); and colorSeparation (neutral, rich_controlled, editorial).",
    "This reference signature must describe the reference image alone. You receive no target and must not infer or recommend any transfer treatment."
  ].join("\n\n");
}

export function buildReferenceStyleTargetAnalysisPrompt({ metrics }) {
  return [
    "Classify only the supplied target video frames' bounded photographic signature. Do not create an edit plan or return numeric controls, filters, LUTs, paths, treatment advice, or prose.",
    "Return only the schema: coherent and compatible booleans; peopleOrSkin; exposure and saturation as low, medium, or high; warmth as cool, neutral, or warm; ambientColorCharacter (neutral, warm_golden, cool_mint, cool_clean); dominantColorBias (neutral, yellow_orange, green_mint, cyan_blue, mixed); highlightCharacter (natural, soft, flash); blackCharacter (lifted, neutral, deep); saturationCharacter (muted, natural, rich); and colorSeparation (neutral, rich_controlled, editorial).",
    "Describe only the target frames. You receive no reference and must not infer or recommend any transfer treatment. Compatibility is diagnostic-only and must not reject a target merely because another image might show a different subject class.",
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
      throw new ReferenceStyleError("REFERENCE_MODEL_REQUEST_FAILED");
    }
    if (!object(safety) || typeof safety.safe !== "boolean" || Object.keys(safety).some((field) => field !== "safe")) {
      throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE", "Invalid reference safety response", "safety");
    }
    if (!safety.safe) throw new ReferenceStyleError("REFERENCE_SAFETY_REJECTED", REFERENCE_STYLE_SAFE_ERROR);
    let referenceResponse;
    try {
      referenceResponse = await generate(ai, { model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: ["REFERENCE IMAGE", createPartFromUri(reference.uri, reference.mimeType || referenceMimeType), buildReferenceStyleReferenceAnalysisPrompt()], config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: referenceStyleReferenceAnalysisSchema() } });
    } catch { throw new ReferenceStyleError("REFERENCE_MODEL_REQUEST_FAILED"); }
    const targets = [];
    for (const frame of targetFrames) {
      const uploadedFrame = await ai.files.upload({ file: frame.imagePath, config: { mimeType: "image/jpeg" } });
      uploaded.push(uploadedFrame); targets.push(uploadedFrame);
    }
    let targetResponse;
    try {
      targetResponse = await generate(ai, { model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: [...targets.flatMap((file, index) => [`TARGET FRAME ${index + 1}`, createPartFromUri(file.uri, file.mimeType || "image/jpeg")]), buildReferenceStyleTargetAnalysisPrompt({ metrics })], config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: referenceStyleTargetAnalysisSchema() } });
    } catch { throw new ReferenceStyleError("REFERENCE_MODEL_REQUEST_FAILED"); }
    try {
      const analysis = validateReferenceStyleAnalysis({
        safe: true,
        reference: validateReferenceStyleReferenceSignature(JSON.parse(referenceResponse.text || "")),
        target: validateReferenceStyleTargetSignature(JSON.parse(targetResponse.text || ""))
      });
      return { analysis, treatment: deriveReferenceStyleTreatment({ analysis, metrics }) };
    }
    catch (error) { if (error instanceof ReferenceStyleError) throw error; throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE"); }
  } finally {
    await Promise.all(uploaded.map((file) => file?.name ? ai.files.delete({ name: file.name }).catch(() => {}) : null));
  }
}

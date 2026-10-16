import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";
import { GoogleGenAI, createPartFromUri } from "@google/genai";

export const REFERENCE_STYLE_SAFE_ERROR = "This reference can’t be used for style matching. Please choose another image or video.";
export const REFERENCE_STYLE_COHERENCE_ERROR = "This first version works best with visually coherent footage. Please choose another video.";

export class ReferenceStyleError extends Error {
  constructor(reason, message = "This reference style could not be applied safely.") { super(message); this.name = "ReferenceStyleError"; this.reason = reason; }
}

const DIRECTIONS = Object.freeze(["lower", "preserve", "raise"]);
const LEVELS = Object.freeze(["low", "medium", "high"]);

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function enumValue(value, values, field) { if (!values.includes(value)) throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE", `Invalid ${field}`); return value; }

/** Strictly validates bounded categorical facts; model prose never reaches FFmpeg. */
export function validateReferenceStyleAnalysis(value) {
  if (!object(value) || typeof value.safe !== "boolean") throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE");
  if (!value.safe) throw new ReferenceStyleError("REFERENCE_SAFETY_REJECTED", REFERENCE_STYLE_SAFE_ERROR);
  if (!object(value.reference) || !object(value.target) || !object(value.treatment)) throw new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE");
  const treatment = value.treatment;
  return Object.freeze({
    reference: Object.freeze({ peopleOrSkin: Boolean(value.reference.peopleOrSkin), exposure: enumValue(value.reference.exposure, LEVELS, "reference exposure"), saturation: enumValue(value.reference.saturation, LEVELS, "reference saturation"), warmth: enumValue(value.reference.warmth, ["cool", "neutral", "warm"], "reference warmth") }),
    target: Object.freeze({ coherent: Boolean(value.target.coherent), peopleOrSkin: Boolean(value.target.peopleOrSkin), exposure: enumValue(value.target.exposure, LEVELS, "target exposure"), saturation: enumValue(value.target.saturation, LEVELS, "target saturation"), warmth: enumValue(value.target.warmth, ["cool", "neutral", "warm"], "target warmth"), compatible: Boolean(value.target.compatible) }),
    treatment: Object.freeze({ exposure: enumValue(treatment.exposure, DIRECTIONS, "treatment exposure"), contrast: enumValue(treatment.contrast, DIRECTIONS, "treatment contrast"), blacks: enumValue(treatment.blacks, DIRECTIONS, "treatment blacks"), highlights: enumValue(treatment.highlights, DIRECTIONS, "treatment highlights"), color: enumValue(treatment.color, DIRECTIONS, "treatment color"), warmth: enumValue(treatment.warmth, ["cool", "neutral", "warm"], "treatment warmth"), mood: enumValue(treatment.mood, ["natural", "soft", "rich", "moody", "luminous"], "treatment mood") })
  });
}

const direction = (value, amount) => value === "raise" ? amount : value === "lower" ? -amount : 0;

/** Server-owned conservative mapping, with deterministic target headroom protection. */
export function deriveReferenceStyleTreatment({ analysis, metrics }) {
  const safe = validateReferenceStyleAnalysis(analysis);
  if (!safe.target.coherent) throw new ReferenceStyleError("REFERENCE_TARGET_HETEROGENEOUS", REFERENCE_STYLE_COHERENCE_ERROR);
  if (!safe.target.compatible) throw new ReferenceStyleError("REFERENCE_COMPATIBILITY_WEAK", "This reference is not a safe match for this video.");
  if (!object(metrics)) throw new ReferenceStyleError("REFERENCE_TREATMENT_DERIVATION_FAILED");
  const brightHeadroom = metrics.lumaP95 < 0.91 && metrics.nearWhiteFraction < 0.03;
  const shadowHeadroom = metrics.lumaP05 > 0.035 && metrics.nearBlackFraction < 0.08;
  const saturated = metrics.saturationIndex > 0.62 || safe.target.saturation === "high";
  const skin = safe.target.peopleOrSkin || safe.reference.peopleOrSkin;
  const recipe = {
    brightness: direction(safe.treatment.exposure, brightHeadroom ? 0.14 : 0.045),
    contrast: direction(safe.treatment.contrast, 0.14),
    saturation: direction(safe.treatment.color, saturated ? 0.04 : 0.12),
    temperature: safe.treatment.warmth === "warm" ? (skin ? 0.07 : 0.14) : safe.treatment.warmth === "cool" ? -0.1 : 0,
    tint: 0,
    shadows: safe.treatment.blacks === "raise" ? 0.1 : safe.treatment.blacks === "lower" && shadowHeadroom ? -0.08 : 0,
    highlights: safe.treatment.highlights === "lower" ? -0.14 : safe.treatment.highlights === "raise" && brightHeadroom ? 0.07 : 0,
    vibrance: safe.treatment.color === "raise" && !saturated ? 0.1 : safe.treatment.color === "lower" ? -0.06 : 0,
    blackLift: safe.treatment.blacks === "raise" ? 0.12 : 0,
    midtoneGamma: safe.treatment.exposure === "raise" && brightHeadroom ? 0.08 : safe.treatment.exposure === "lower" && shadowHeadroom ? -0.06 : 0
  };
  return createCanonicalReferenceStyleTreatment({ version: 1, recipe });
}

export function requestsReferenceStyleMatch(prompt = "", hasReference = false) {
  return Boolean(hasReference && /\b(?:make|match|use|give)\b[\s\S]{0,80}\b(?:look like this|this style|reference (?:style|look)|style reference|same look)\b/i.test(prompt));
}

export function referenceStyleAnalysisSchema() {
  const level = { type: "string", enum: LEVELS };
  const directionSchema = { type: "string", enum: DIRECTIONS };
  return { type: "object", properties: {
    safe: { type: "boolean" },
    reference: { type: "object", properties: { peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] } }, required: ["peopleOrSkin", "exposure", "saturation", "warmth"], additionalProperties: false },
    target: { type: "object", properties: { coherent: { type: "boolean" }, peopleOrSkin: { type: "boolean" }, exposure: level, saturation: level, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, compatible: { type: "boolean" } }, required: ["coherent", "peopleOrSkin", "exposure", "saturation", "warmth", "compatible"], additionalProperties: false },
    treatment: { type: "object", properties: { exposure: directionSchema, contrast: directionSchema, blacks: directionSchema, highlights: directionSchema, color: directionSchema, warmth: { type: "string", enum: ["cool", "neutral", "warm"] }, mood: { type: "string", enum: ["natural", "soft", "rich", "moody", "luminous"] } }, required: ["exposure", "contrast", "blacks", "highlights", "color", "warmth", "mood"], additionalProperties: false }
  }, required: ["safe", "reference", "target", "treatment"], additionalProperties: false };
}

export function referenceSafetySchema() {
  return { type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"], additionalProperties: false };
}

export function buildReferenceStyleAnalysisPrompt({ metrics }) {
  return [
    "You assess whether a supplied reference image can safely guide photographic color treatment for supplied target video frames. Do not create an edit plan or return numeric controls, filters, LUTs, paths, or prose.",
    "Reject only clearly high-risk explicit sexual content, sexual content involving minors, sexual violence, or extreme graphic gore. Ordinary portraits, fashion, swimwear, kissing, and lifestyle scenes are safe.",
    "Separate scene facts from treatment. Never copy reference objects or colors into the target. Return the bounded categorical schema only.",
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

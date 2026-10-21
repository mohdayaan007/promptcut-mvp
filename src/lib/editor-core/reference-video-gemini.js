import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import {
  REFERENCE_VIDEO_OBSERVATIONS_VERSION,
  RV1_INTERPRETER_TIMEOUT_MS,
  RV1_MAX_INTERPRETER_CALLS,
  RV1_MAX_MODEL_RESPONSE_BYTES,
  aggregateReferenceVideoCreativeSignature,
  interpretReferenceVideoEvidence,
  ReferenceVideoObservationError
} from "@/lib/editor-core/reference-video-understanding";

export const REFERENCE_VIDEO_GEMINI_SCHEMA_VERSION = 1;
export const REFERENCE_VIDEO_GEMINI_MODEL = "gemini-3.6-flash";
export const REFERENCE_VIDEO_SAFETY_ERROR = "This reference can’t be used for style matching. Please choose another image or video.";

const PHOTOGRAPHIC_PALETTES = ["unknown", "neutral", "warm", "cool", "mixed"];
const LEVELS = ["unknown", "low", "medium", "high"];
const TYPE_STATES = ["unknown", "absent", "present", "ambiguous"];
const TYPE_ROLES = ["unknown", "creative_title", "supporting_text", "subtitle", "environmental", "interface"];

export class ReferenceVideoGeminiError extends ReferenceVideoObservationError {
  constructor(reason, message = "Reference-video evidence could not be interpreted safely.") {
    super(reason, message);
    this.name = "ReferenceVideoGeminiError";
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObject(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function enumSchema(values) { return { type: "string", enum: values }; }
function isJpeg(bytes) { return Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; }

/** Versioned descriptive-only contract. It deliberately has no plan/filter/font-path fields. */
export function referenceVideoGeminiObservationSchema() {
  const observation = {
    type: "object",
    properties: {
      observationId: { type: "string" },
      shotId: { type: "string" },
      frameIds: { type: "array", minItems: 1, maxItems: 18, items: { type: "string" } },
      start: { type: "number" }, end: { type: "number" },
      photographic: { type: "object", properties: { palette: enumSchema(PHOTOGRAPHIC_PALETTES), exposure: enumSchema(LEVELS), contrast: enumSchema(LEVELS), saturation: enumSchema(LEVELS), texture: enumSchema(["unknown", "clean", "soft", "grain"]) }, required: ["palette", "exposure", "contrast", "saturation", "texture"], additionalProperties: false },
      typography: { type: "object", properties: { state: enumSchema(TYPE_STATES), role: enumSchema(TYPE_ROLES), prominence: enumSchema(LEVELS), fontCharacter: enumSchema(["unknown", "serif", "sans", "display", "handwritten"]), weight: enumSchema(["unknown", "light", "regular", "bold"]), position: enumSchema(["unknown", "top", "center", "bottom", "corner"]), alignment: enumSchema(["unknown", "left", "center", "right"]), colorCharacter: enumSchema(["unknown", "light", "dark", "warm", "cool", "mixed"]) }, required: ["state", "role", "prominence", "fontCharacter", "weight", "position", "alignment", "colorCharacter"], additionalProperties: false },
      composition: { type: "object", properties: { framing: enumSchema(["unknown", "wide", "medium", "close"]), balance: enumSchema(["unknown", "symmetric", "asymmetric", "centered"]), titleSafeArea: enumSchema(["unknown", "none", "top", "center", "bottom"]), subjectPlacement: enumSchema(["unknown", "left", "center", "right", "multiple"]), negativeSpace: enumSchema(LEVELS) }, required: ["framing", "balance", "titleSafeArea", "subjectPlacement", "negativeSpace"], additionalProperties: false },
      rhythm: { type: "object", properties: { pacing: enumSchema(["unknown", "slow", "medium", "fast"]) }, required: ["pacing"], additionalProperties: false },
      transition: { type: "object", properties: { type: enumSchema(["unknown", "hard_cut", "gradual"]) }, required: ["type"], additionalProperties: false }
    },
    required: ["observationId", "shotId", "frameIds", "start", "end", "photographic", "typography", "composition", "rhythm", "transition"],
    additionalProperties: false
  };
  return {
    type: "object",
    properties: {
      schemaVersion: { type: "integer", enum: [REFERENCE_VIDEO_GEMINI_SCHEMA_VERSION] },
      safe: { type: "boolean" },
      observations: { type: "array", minItems: 0, maxItems: 18, items: observation }
    },
    required: ["schemaVersion", "safe", "observations"],
    additionalProperties: false
  };
}

export function buildReferenceVideoGeminiPrompt({ shots, frames }) {
  return [
    "You are interpreting bounded, private reference-video frame evidence. Return JSON only matching the supplied schema.",
    "First set safe=false only for explicit sexual acts/pornography, sexual content involving minors, sexual violence, or extreme graphic gore. Fashion, swimwear, kissing, portraits, and lifestyle are safe. If safe=false, return observations: [].",
    "If safe=true, describe only visible characteristics supported by the supplied frames and server-owned timeline. Do not create edit plans, filters, LUTs, arbitrary fonts, prose, image paths, URLs, or timestamps not grounded by server metadata.",
    "Every observation must cite only the provided frameId(s), use their exact shotId, and select a start/end interval inside that shot that contains every cited frame timestamp. One frame proves only that sampled moment; use unknown rather than claiming persistence. Do not overlap observations in one shot.",
    "Typography is present only for visible designed creative text. Environmental text, subtitles, watermarks, and platform UI are not creative titles. Never infer an exact proprietary font; use only the bounded fontCharacter categories. Visual-change candidates are candidates, not proof of typography or a transition.",
    `Server-owned shots: ${JSON.stringify(shots)}.`,
    `Server-owned frames: ${JSON.stringify(frames.map(({ frameId, shotId, timestamp }) => ({ frameId, shotId, timestamp })))}.`
  ].join("\n\n");
}

/** Builds the one bounded SDK request without sending it; used by local dry-run evaluation. */
export function prepareReferenceVideoGeminiRequest({ frames, shots, signal } = {}) {
  if (!Array.isArray(frames) || !frames.length || frames.some((frame) => frame?.mimeType !== "image/jpeg" || !isJpeg(frame.bytes))) throw new ReferenceVideoGeminiError("RV2B_NO_USABLE_EVIDENCE");
  const contents = [buildReferenceVideoGeminiPrompt({ shots, frames })];
  for (const frame of frames) {
    contents.push(`FRAME ${frame.frameId}; shot ${frame.shotId}; timestamp ${frame.timestamp}.`);
    contents.push(createPartFromBase64(frame.bytes.toString("base64"), frame.mimeType));
  }
  return Object.freeze({
    contents: Object.freeze(contents),
    config: Object.freeze({ temperature: 0, abortSignal: signal, automaticFunctionCalling: Object.freeze({ disable: true }), responseMimeType: "application/json", responseJsonSchema: referenceVideoGeminiObservationSchema() })
  });
}

function parseModelResponse(response) {
  const text = typeof response?.text === "string" ? response.text : "";
  if (Buffer.byteLength(text) > RV1_MAX_MODEL_RESPONSE_BYTES) throw new ReferenceVideoGeminiError("RV2B_RESPONSE_TOO_LARGE");
  if (!text.trim()) throw new ReferenceVideoGeminiError("RV2B_INVALID_MODEL_RESPONSE");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ReferenceVideoGeminiError("RV2B_INVALID_MODEL_RESPONSE"); }
  if (!exactObject(parsed, ["schemaVersion", "safe", "observations"]) || parsed.schemaVersion !== REFERENCE_VIDEO_GEMINI_SCHEMA_VERSION || typeof parsed.safe !== "boolean" || !Array.isArray(parsed.observations)) throw new ReferenceVideoGeminiError("RV2B_INVALID_MODEL_RESPONSE");
  if (!parsed.safe) throw new ReferenceVideoGeminiError("RV2B_REFERENCE_SAFETY_REJECTED", REFERENCE_VIDEO_SAFETY_ERROR);
  return { version: REFERENCE_VIDEO_OBSERVATIONS_VERSION, observations: parsed.observations };
}

/** One direct-image request only: no Gemini File is created, retained, or logged. */
export function createGeminiReferenceVideoInterpreter({ aiClient, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || REFERENCE_VIDEO_GEMINI_MODEL } = {}) {
  const ai = aiClient || new GoogleGenAI({ apiKey });
  return async ({ frames, shots, signal, callBudget }) => {
    if (callBudget !== RV1_MAX_INTERPRETER_CALLS || signal?.aborted) throw new ReferenceVideoGeminiError("RV2B_INTERPRETER_CANCELLED");
    const request = prepareReferenceVideoGeminiRequest({ frames, shots, signal });
    try {
      const response = await ai.models.generateContent({
        model,
        ...request
      });
      if (signal?.aborted) throw new ReferenceVideoGeminiError("RV2B_INTERPRETER_CANCELLED");
      return parseModelResponse(response);
    } catch (error) {
      if (error instanceof ReferenceVideoGeminiError) throw error;
      if (signal?.aborted || error?.name === "AbortError") throw new ReferenceVideoGeminiError("RV2B_INTERPRETER_CANCELLED");
      throw new ReferenceVideoGeminiError("RV2B_MODEL_REQUEST_FAILED");
    }
  };
}

/** Internal integration only: temporal extraction is separate and remains server-owned. */
export async function analyzeReferenceVideoWithGemini({ evidence, signal, aiClient, apiKey, model, timeoutMs = RV1_INTERPRETER_TIMEOUT_MS, loadVisualEvidence } = {}) {
  const observations = await interpretReferenceVideoEvidence({
    evidence,
    signal,
    timeoutMs,
    loadVisualEvidence,
    interpret: createGeminiReferenceVideoInterpreter({ aiClient, apiKey, model })
  });
  if (!observations.observations.length) throw new ReferenceVideoGeminiError("RV2B_NO_USABLE_EVIDENCE");
  return Object.freeze({ observations, signature: aggregateReferenceVideoCreativeSignature({ evidence, observations }) });
}

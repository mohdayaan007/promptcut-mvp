import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { COLOR_MAP, FONT_CATALOG, POSITION_MAP, TITLE_SIZE_PRESETS, normalizeTitleColor, normalizeTitlePosition, normalizeTitleSize, normalizeTitleWeight } from "@/lib/title-config";

const MODEL = "gemini-3.6-flash";
const FONT_BY_CHARACTER = Object.freeze({
  serif: "instrumentSerif",
  sans_serif: "inter",
  monospace: "jetbrainsMono"
});
const TYPOGRAPHY_STYLES = Object.freeze(["single", "multiple", "none"]);
const FONT_CHARACTERS = Object.freeze(Object.keys(FONT_BY_CHARACTER));
const CASE_STYLES = Object.freeze(["as_supplied", "uppercase", "lowercase", "title_case"]);
const COLOR_NAMES = Object.freeze(Object.keys(COLOR_MAP));
const POSITION_NAMES = Object.freeze(Object.keys(POSITION_MAP));
const SIZE_NAMES = Object.freeze(Object.keys(TITLE_SIZE_PRESETS));
const WEIGHT_NAMES = Object.freeze(["regular", "bold"]);

export class TypographyReferenceError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TypographyReferenceError";
    this.reason = reason;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields) {
  return isPlainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function enumValue(value, values) {
  return typeof value === "string" && values.includes(value) ? value : null;
}

/** Explicitly routes reference-driven title styling away from B2A photography. */
export function requestsTypographyReferenceMatch(prompt = "", hasReference = false) {
  if (!hasReference) return false;
  const text = String(prompt);
  return /\b(?:typography|typeface|font(?:\s+style)?|title\s+style)\b[\s\S]{0,80}\b(?:this|the)?\s*reference\b/i.test(text)
    || /\b(?:this|the)?\s*reference\b[\s\S]{0,80}\b(?:typography|typeface|font(?:\s+style)?|title\s+style)\b/i.test(text);
}

export function typographyReferenceAnalysisSchema() {
  return {
    type: "object",
    properties: {
      safe: { type: "boolean" },
      typography: { type: "string", enum: TYPOGRAPHY_STYLES },
      fontCharacter: { type: "string", enum: FONT_CHARACTERS },
      weight: { type: "string", enum: WEIGHT_NAMES },
      caseStyle: { type: "string", enum: CASE_STYLES },
      size: { type: "string", enum: SIZE_NAMES },
      color: { type: "string", enum: COLOR_NAMES },
      position: { type: "string", enum: POSITION_NAMES },
      lineBreakStyle: { type: "string", enum: ["single_line", "multi_line"] }
    },
    required: ["safe", "typography", "fontCharacter", "weight", "caseStyle", "size", "color", "position", "lineBreakStyle"],
    additionalProperties: false
  };
}

/** Validates observations only; it never accepts a font path, renderer syntax, or model recipe. */
export function validateTypographyReferenceAnalysis(value) {
  const fields = ["safe", "typography", "fontCharacter", "weight", "caseStyle", "size", "color", "position", "lineBreakStyle"];
  if (!exactObject(value, fields) || typeof value.safe !== "boolean") {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  const typography = enumValue(value.typography, TYPOGRAPHY_STYLES);
  const fontCharacter = enumValue(value.fontCharacter, FONT_CHARACTERS);
  const weight = normalizeTitleWeight(value.weight);
  const caseStyle = enumValue(value.caseStyle, CASE_STYLES);
  const size = normalizeTitleSize(value.size);
  const color = normalizeTitleColor(value.color);
  const position = normalizeTitlePosition(value.position);
  const lineBreakStyle = enumValue(value.lineBreakStyle, ["single_line", "multi_line"]);
  if (!typography || !fontCharacter || !weight || !caseStyle || !size || !color || !position || !lineBreakStyle) {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  return Object.freeze({ safe: value.safe, typography, fontCharacter, weight, caseStyle, size, color, position, lineBreakStyle });
}

/** Maps a bounded observed signature to the closest installed Cliponaut font. */
export function deriveTypographyTitleTreatment(analysis) {
  const safe = validateTypographyReferenceAnalysis(analysis);
  if (!safe.safe) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_SAFETY_REJECTED");
  if (safe.typography === "multiple") throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_AMBIGUOUS");
  if (safe.typography === "none") throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_NO_TEXT");
  const font = FONT_BY_CHARACTER[safe.fontCharacter];
  if (!font || !FONT_CATALOG[font]?.weights.includes(safe.weight)) {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  return Object.freeze({
    font,
    weight: safe.weight,
    size: safe.size,
    color: safe.color,
    position: safe.position,
    // Observational only: Stage 1 never changes the user's supplied title text.
    caseStyle: safe.caseStyle,
    lineBreakStyle: safe.lineBreakStyle
  });
}

export function buildTypographyReferenceAnalysisPrompt() {
  return [
    "Analyze the supplied image only as a typography reference for an existing video title renderer. Do not create an edit plan or return text from the image, font names, font files, file paths, renderer syntax, filters, or numeric controls.",
    "First set safe=false only for explicit sexual acts/pornography, sexual content involving minors, sexual violence, or extreme graphic gore. Fashion, swimwear, kissing, portraits, and lifestyle images are safe.",
    "Classify typography as single when one clear usable title style dominates, multiple when two or more clearly different styles compete with no safe default, or none when there is no meaningful readable typography.",
    "For a single style, classify only these supported observations: serif, sans_serif, or monospace; regular or bold; as_supplied, uppercase, lowercase, or title_case; small, medium, or large; one closest supported named color; one supported title position; and single_line or multi_line. Select the closest visual alternative rather than claiming an exact proprietary font.",
    "Return only JSON matching the supplied schema."
  ].join("\n\n");
}

function statusCode(error) {
  return Number(error?.status || error?.statusCode || error?.code || error?.$metadata?.httpStatusCode);
}

function isTransient(error) {
  const status = statusCode(error);
  return status === 429 || status === 503 || (status >= 500 && status < 600);
}

async function generateWithRetries(ai, request) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await ai.models.generateContent(request); }
    catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
  throw lastError;
}

/** Uploads only the scratch reference image and always removes its Gemini File. */
export async function analyzeTypographyReference({ referencePath, referenceMimeType, aiClient }) {
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let uploaded;
  try {
    uploaded = await ai.files.upload({ file: referencePath, config: { mimeType: referenceMimeType } });
    const response = await generateWithRetries(ai, {
      model: process.env.GEMINI_MODEL || MODEL,
      contents: ["TYPOGRAPHY REFERENCE IMAGE", createPartFromUri(uploaded.uri, uploaded.mimeType || referenceMimeType), buildTypographyReferenceAnalysisPrompt()],
      config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: typographyReferenceAnalysisSchema() }
    });
    if (typeof response?.text !== "string" || !response.text.trim()) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
    const analysis = validateTypographyReferenceAnalysis(JSON.parse(response.text));
    return Object.freeze({ analysis, treatment: deriveTypographyTitleTreatment(analysis) });
  } catch (error) {
    if (error instanceof TypographyReferenceError) throw error;
    if (error instanceof SyntaxError) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_MODEL_REQUEST_FAILED");
  } finally {
    if (uploaded?.name) await ai.files.delete({ name: uploaded.name }).catch(() => {});
  }
}

/** Replaces styling only; title wording and timing always remain server/user owned. */
export function reconcileTypographyReferenceTitlePlan(plan, title, treatment) {
  if (!title?.text || !Number.isFinite(title.start) || !Number.isFinite(title.end) || title.end <= title.start) {
    throw new TypographyReferenceError("TYPOGRAPHY_TITLE_REQUIRED");
  }
  const safeTreatment = deriveTypographyTitleTreatment({
    safe: true,
    typography: "single",
    fontCharacter: Object.entries(FONT_BY_CHARACTER).find(([, font]) => font === treatment?.font)?.[0],
    weight: treatment?.weight,
    caseStyle: treatment?.caseStyle || "as_supplied",
    size: treatment?.size,
    color: treatment?.color,
    position: treatment?.position,
    lineBreakStyle: treatment?.lineBreakStyle || "single_line"
  });
  const titles = (plan?.operations || []).filter((operation) => operation?.type === "title");
  if (titles.length > 1) throw new TypographyReferenceError("TYPOGRAPHY_TITLE_REQUIRED");
  const resolved = {
    type: "title",
    text: title.text,
    start: title.start,
    end: title.end,
    position: safeTreatment.position,
    size: safeTreatment.size,
    color: safeTreatment.color,
    weight: safeTreatment.weight,
    font: safeTreatment.font,
    runs: [{ text: title.text, font: safeTreatment.font, size: safeTreatment.size, color: safeTreatment.color, weight: safeTreatment.weight }]
  };
  const operations = titles.length
    ? plan.operations.map((operation) => operation.type === "title" ? resolved : operation)
    : [...(plan?.operations || []), resolved];
  return { ...(plan || { version: "1" }), operations };
}

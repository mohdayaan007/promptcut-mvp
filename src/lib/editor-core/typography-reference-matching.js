import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { COLOR_MAP, FONT_CATALOG, POSITION_MAP, TITLE_SIZE_PRESETS, normalizeTitleColor, normalizeTitlePosition, normalizeTitleSize, normalizeTitleWeight } from "@/lib/title-config";

const MODEL = "gemini-3.6-flash";
const FONT_BY_CHARACTER = Object.freeze({
  serif: "instrumentSerif",
  sans_serif: "inter",
  condensed_sans: "barlowCondensed",
  monospace: "jetbrainsMono"
});
const TYPOGRAPHY_STYLES = Object.freeze(["single", "multiple", "none"]);
const FONT_CHARACTERS = Object.freeze(Object.keys(FONT_BY_CHARACTER));
const CASE_STYLES = Object.freeze(["as_supplied", "uppercase", "lowercase", "title_case"]);
const TYPOGRAPHY_ROLES = Object.freeze(["creative_title", "supporting_text", "platform_ui"]);
const TYPOGRAPHY_PROMINENCE = Object.freeze(["low", "standard", "high"]);
const COLOR_NAMES = Object.freeze(Object.keys(COLOR_MAP));
const POSITION_NAMES = Object.freeze(Object.keys(POSITION_MAP));
const SIZE_NAMES = Object.freeze(Object.keys(TITLE_SIZE_PRESETS));
const WEIGHT_NAMES = Object.freeze(["regular", "bold"]);

export class TypographyReferenceError extends Error {
  constructor(reason, selectionDiagnostic = null) {
    super(reason);
    this.name = "TypographyReferenceError";
    this.reason = reason;
    this.selectionDiagnostic = selectionDiagnostic;
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
  const reference = "(?:this|the)?\\s*(?:reference|screenshot)";
  const typography = "(?:typography|typeface|font(?:\\s+style)?|title\\s+style|(?:serif|sans(?:-?serif)?|condensed|monospace)\\s+(?:title|heading|headline))";
  return new RegExp(`\\b${typography}\\b[\\s\\S]{0,80}\\b${reference}\\b`, "i").test(text)
    || new RegExp(`\\b${reference}\\b[\\s\\S]{0,80}\\b${typography}\\b`, "i").test(text);
}

export function typographyReferenceAnalysisSchema() {
  const candidate = {
    type: "object",
    properties: {
      candidateId: { type: "string", pattern: "^candidate-[1-4]$" },
      referenceText: { type: "string", maxLength: 160 },
      role: { type: "string", enum: TYPOGRAPHY_ROLES },
      prominence: { type: "string", enum: TYPOGRAPHY_PROMINENCE },
      fontCharacter: { type: "string", enum: FONT_CHARACTERS },
      weight: { type: "string", enum: WEIGHT_NAMES },
      caseStyle: { type: "string", enum: CASE_STYLES },
      size: { type: "string", enum: SIZE_NAMES },
      color: { type: "string", enum: COLOR_NAMES },
      position: { type: "string", enum: POSITION_NAMES },
      lineBreakStyle: { type: "string", enum: ["single_line", "multi_line"] }
    },
    required: ["candidateId", "referenceText", "role", "prominence", "fontCharacter", "weight", "caseStyle", "size", "color", "position", "lineBreakStyle"],
    additionalProperties: false
  };
  return {
    type: "object",
    properties: {
      safe: { type: "boolean" },
      typography: { type: "string", enum: TYPOGRAPHY_STYLES },
      candidates: { type: "array", minItems: 0, maxItems: 4, items: candidate }
    },
    required: ["safe", "typography", "candidates"],
    additionalProperties: false
  };
}

/** Validates observations only; it never accepts a font path, renderer syntax, or model recipe. */
export function validateTypographyReferenceAnalysis(value) {
  const fields = ["safe", "typography", "candidates"];
  if (!exactObject(value, fields) || typeof value.safe !== "boolean") {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  const typography = enumValue(value.typography, TYPOGRAPHY_STYLES);
  if (!typography || !Array.isArray(value.candidates) || value.candidates.length > 4 || (typography === "none" && value.candidates.length)) {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  const candidateFields = ["candidateId", "referenceText", "role", "prominence", "fontCharacter", "weight", "caseStyle", "size", "color", "position", "lineBreakStyle"];
  const candidateIds = new Set();
  const candidates = value.candidates.map((candidate) => {
    if (!exactObject(candidate, candidateFields) || !/^candidate-[1-4]$/.test(candidate.candidateId) || candidateIds.has(candidate.candidateId)) {
      throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
    }
    candidateIds.add(candidate.candidateId);
    const role = enumValue(candidate.role, TYPOGRAPHY_ROLES);
    const prominence = enumValue(candidate.prominence, TYPOGRAPHY_PROMINENCE);
    const fontCharacter = enumValue(candidate.fontCharacter, FONT_CHARACTERS);
    const weight = normalizeTitleWeight(candidate.weight);
    const caseStyle = enumValue(candidate.caseStyle, CASE_STYLES);
    const size = normalizeTitleSize(candidate.size);
    const color = normalizeTitleColor(candidate.color);
    const position = normalizeTitlePosition(candidate.position);
    const lineBreakStyle = enumValue(candidate.lineBreakStyle, ["single_line", "multi_line"]);
    if (typeof candidate.referenceText !== "string" || candidate.referenceText.length > 160 || !role || !prominence || !fontCharacter || !weight || !caseStyle || !size || !color || !position || !lineBreakStyle) {
      throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
    }
    return Object.freeze({ candidateId: candidate.candidateId, referenceText: candidate.referenceText.trim(), role, prominence, fontCharacter, weight, caseStyle, size, color, position, lineBreakStyle });
  });
  if (typography !== "none" && !candidates.length) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  return Object.freeze({ safe: value.safe, typography, candidates: Object.freeze(candidates) });
}

function normalizedText(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Extracts only bounded, user-written selection facts; no general OCR/NLP layer. */
export function extractTypographyReferenceSelector(prompt = "") {
  const fullPrompt = String(prompt);
  const referenceClause = fullPrompt.split(/\b(?:and\s+)?(?:add|show|put)\s+(?:the\s+)?title\b/i)[0];
  const quoted = referenceClause.match(/\b(?:font|typeface|typography|style)\s+(?:of|from)\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)/i);
  const referenceText = quoted?.slice(1).find(Boolean);
  const lower = referenceClause.toLowerCase();
  // Prominence is relative to the candidates in this one screenshot, rather
  // than a claim that Gemini must use our absolute title-size preset.
  const prominence = /\b(?:big|large|main|prominent)\b/.test(lower) ? "high" : /\b(?:small|tiny)\b/.test(lower) ? "low" : null;
  const color = COLOR_NAMES.find((value) => new RegExp(`\\b${value}\\b`, "i").test(referenceClause)) || null;
  const fontCharacter = /\b(?:condensed|narrow|tall)\b/i.test(referenceClause) ? "condensed_sans" : /\bmono(?:space)?\b/i.test(referenceClause) ? "monospace" : /\bserif\b/i.test(referenceClause) ? "serif" : /\b(?:sans(?:-?serif)?|modern|minimal)\b/i.test(referenceClause) ? "sans_serif" : null;
  const role = /\b(?:title|heading|headline)\b/i.test(referenceClause) ? "creative_title" : /\b(?:subtitle|caption|supporting)\b/i.test(referenceClause) ? "supporting_text" : null;
  const position = /\b(?:upper\s+third|top)\b/i.test(referenceClause) ? "top-center" : /\bbottom\b/i.test(referenceClause) ? "bottom-center" : /\bcenter(?:ed)?\b/i.test(referenceClause) ? "center" : null;
  const preserveCase = /\b(?:keep|preserve|retain)\s+(?:the\s+)?(?:original\s+)?(?:letter\s+)?(?:case|casing)\b/i.test(fullPrompt);
  const selector = { ...(referenceText ? { referenceText } : {}), ...(prominence ? { prominence } : {}), ...(color ? { color: normalizeTitleColor(color) } : {}), ...(fontCharacter ? { fontCharacter } : {}), ...(role ? { role } : {}), ...(position ? { position } : {}), ...(preserveCase ? { preserveCase: true } : {}) };
  return Object.keys(selector).length ? Object.freeze(selector) : null;
}

function colorName(color) {
  return Object.entries(COLOR_MAP).find(([, hex]) => hex === color)?.[0] || "unknown";
}

function selectorSummary(selector) {
  return {
    hasReferenceText: Boolean(selector?.referenceText), prominence: selector?.prominence || null,
    color: selector?.color ? colorName(selector.color) : null, fontCharacter: selector?.fontCharacter || null,
    role: selector?.role || null, position: selector?.position || null, preserveCase: Boolean(selector?.preserveCase)
  };
}

function candidateSummary(candidate) {
  return {
    candidateId: candidate.candidateId, role: candidate.role, color: colorName(candidate.color),
    size: candidate.size, prominence: candidate.prominence, fontCharacter: candidate.fontCharacter,
    caseStyle: candidate.caseStyle, position: candidate.position
  };
}

function selectionError(reason, selector, candidates, checks) {
  return new TypographyReferenceError(reason, Object.freeze({
    selector: selectorSummary(selector), candidateCount: candidates.length,
    candidates: Object.freeze(candidates.slice(0, 4).map(candidateSummary)), checks: Object.freeze(checks)
  }));
}

function colorEvidence(requested, candidate) {
  if (!requested) return { matched: false, score: 0 };
  if (requested === candidate) return { matched: true, score: 4 };
  const adjacent = new Map([["blue", ["purple"]], ["purple", ["blue", "pink"]], ["green", ["blue"]], ["orange", ["yellow", "red"]], ["yellow", ["orange"]], ["pink", ["purple", "red"]], ["red", ["orange", "pink"]]]);
  return { matched: adjacent.get(colorName(requested))?.includes(colorName(candidate)) || false, score: adjacent.get(colorName(requested))?.includes(colorName(candidate)) ? 2 : 0 };
}

/** Selects only one non-interface candidate; zero or multiple plausible matches fail closed. */
export function selectTypographyReferenceCandidate(analysis, selector = null) {
  const safe = validateTypographyReferenceAnalysis(analysis);
  if (!safe.safe) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_SAFETY_REJECTED");
  if (safe.typography === "none") throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_NO_TEXT");
  let candidates = safe.candidates.filter((candidate) => candidate.role !== "platform_ui");
  if (selector?.referenceText) {
    const wanted = normalizedText(selector.referenceText);
    candidates = candidates.filter((candidate) => {
      const visible = normalizedText(candidate.referenceText);
      return visible === wanted || (wanted.length >= 3 && visible.includes(wanted));
    });
    if (!candidates.length) throw selectionError("TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH", selector, safe.candidates, ["reference_text_unmatched"]);
    if (candidates.length > 1) throw selectionError("TYPOGRAPHY_REFERENCE_AMBIGUOUS", selector, safe.candidates, ["reference_text_tied"]);
    // Quoted visible copy is stronger grounding than a relative descriptor.
    return candidates[0];
  }
  if (!candidates.length) throw selectionError(selector ? "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH" : "TYPOGRAPHY_REFERENCE_NO_TEXT", selector, safe.candidates, ["no_non_ui_candidates"]);
  if (!selector || ![selector.color, selector.fontCharacter, selector.role, selector.position, selector.prominence].some(Boolean)) {
    if (candidates.length === 1) return candidates[0];
    throw selectionError("TYPOGRAPHY_REFERENCE_AMBIGUOUS", selector, safe.candidates, ["multiple_unselected_candidates"]);
  }
  const maximumProminence = selector.prominence === "high" ? Math.max(...candidates.map((candidate) => ({ low: 1, standard: 2, high: 3 }[candidate.prominence]))) : null;
  const scored = candidates.map((candidate) => {
    const color = colorEvidence(selector?.color, candidate.color);
    const matches = {
      color: color.matched, fontCharacter: !selector?.fontCharacter || candidate.fontCharacter === selector.fontCharacter,
      role: !selector?.role || candidate.role === selector.role, position: !selector?.position || candidate.position === selector.position,
      prominence: !selector?.prominence || (selector.prominence === "high" ? ({ low: 1, standard: 2, high: 3 }[candidate.prominence]) === maximumProminence : candidate.prominence === "low")
    };
    const score = color.score + (matches.fontCharacter && selector?.fontCharacter ? 2 : 0) + (matches.role && selector?.role ? 3 : 0) + (matches.position && selector?.position ? 1 : 0) + (matches.prominence && selector?.prominence ? 2 : 0);
    return { candidate, score, matchedCount: Object.values(matches).filter(Boolean).length, matches };
  });
  const highest = Math.max(...scored.map((entry) => entry.score));
  const winners = scored.filter((entry) => entry.score === highest);
  const checks = scored.map((entry) => ({ candidateId: entry.candidate.candidateId, score: entry.score, ...entry.matches }));
  if (highest < 4 || winners.length !== 1 || winners[0].matchedCount < 2) {
    throw selectionError(winners.length > 1 && highest >= 4 ? "TYPOGRAPHY_REFERENCE_AMBIGUOUS" : "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH", selector, safe.candidates, checks);
  }
  return winners[0].candidate;
}

/** Maps a bounded observed signature to the closest installed Cliponaut font. */
export function deriveTypographyTitleTreatment(analysis, selector = null) {
  const selected = selectTypographyReferenceCandidate(analysis, selector);
  const font = FONT_BY_CHARACTER[selected.fontCharacter];
  if (!font || !FONT_CATALOG[font]?.weights.includes(selected.weight)) {
    throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  }
  return Object.freeze({
    font,
    weight: selected.weight,
    size: selected.size,
    color: selected.color,
    position: selected.position,
    // Observational only: Stage 1 never changes the user's supplied title text.
    caseStyle: selector?.preserveCase ? "as_supplied" : selected.caseStyle,
    lineBreakStyle: selected.lineBreakStyle,
    heroDisplay: selected.role === "creative_title" && selected.prominence === "high" && selected.fontCharacter === "condensed_sans" && selected.weight === "bold" && selected.caseStyle === "uppercase",
    selectedCandidateId: selected.candidateId
  });
}

export function buildTypographyReferenceAnalysisPrompt(selector = null) {
  return [
    "Analyze the supplied image only as a typography reference for an existing video title renderer. Do not create an edit plan or return text from the image, font names, font files, file paths, renderer syntax, filters, or numeric controls.",
    "First set safe=false only for explicit sexual acts/pornography, sexual content involving minors, sexual violence, or extreme graphic gore. Fashion, swimwear, kissing, portraits, and lifestyle images are safe.",
    "Classify typography as single when one clear usable creative title style dominates, multiple when two or more clearly different creative styles compete, or none when there is no meaningful readable typography. Return every distinct visible treatment as at most four candidates. Mark each candidate as creative_title, supporting_text, or platform_ui. Incidental usernames, controls, and social-platform interface text are platform_ui, not a creative title.",
    "For every candidate return only these supported observations: a short visible referenceText for grounding; creative_title, supporting_text, or platform_ui role; low, standard, or high prominence relative to other visible text; serif, sans_serif, condensed_sans (only for visibly tall/narrow display sans), or monospace; regular or bold; as_supplied, uppercase, lowercase, or title_case; small, medium, or large; one closest supported named color; one supported title position; and single_line or multi_line. Select the closest visual alternative rather than claiming an exact proprietary font.",
    selector ? `The user supplied these bounded selection clues. Treat them only as a request for which visible candidate to describe; never invent absent text or style: ${JSON.stringify({ ...selectorSummary(selector), ...(selector.referenceText ? { referenceText: String(selector.referenceText).slice(0, 160) } : {}) })}.` : "",
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
export async function analyzeTypographyReference({ referencePath, referenceMimeType, selector = null, aiClient }) {
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let uploaded;
  try {
    uploaded = await ai.files.upload({ file: referencePath, config: { mimeType: referenceMimeType } });
    const response = await generateWithRetries(ai, {
      model: process.env.GEMINI_MODEL || MODEL,
      contents: ["TYPOGRAPHY REFERENCE IMAGE", createPartFromUri(uploaded.uri, uploaded.mimeType || referenceMimeType), buildTypographyReferenceAnalysisPrompt(selector)],
      config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: typographyReferenceAnalysisSchema() }
    });
    if (typeof response?.text !== "string" || !response.text.trim()) throw new TypographyReferenceError("TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
    const analysis = validateTypographyReferenceAnalysis(JSON.parse(response.text));
    return Object.freeze({ analysis, treatment: deriveTypographyTitleTreatment(analysis, selector) });
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
    candidates: [{
      candidateId: "candidate-1",
      referenceText: "",
      role: "creative_title",
      prominence: treatment?.heroDisplay ? "high" : "standard",
      fontCharacter: Object.entries(FONT_BY_CHARACTER).find(([, font]) => font === treatment?.font)?.[0],
      weight: treatment?.weight,
      caseStyle: treatment?.caseStyle || "as_supplied",
      size: treatment?.size,
      color: treatment?.color,
      position: treatment?.position,
      lineBreakStyle: treatment?.lineBreakStyle || "single_line"
    }]
  });
  const titles = (plan?.operations || []).filter((operation) => operation?.type === "title");
  if (titles.length > 1) throw new TypographyReferenceError("TYPOGRAPHY_TITLE_REQUIRED");
  const resolved = {
    type: "title",
    text: title.text,
    start: title.start,
    end: title.end,
    position: safeTreatment.heroDisplay ? "upper-third" : safeTreatment.position,
    size: safeTreatment.size,
    color: safeTreatment.color,
    weight: safeTreatment.weight,
    font: safeTreatment.font,
    renderCaseStyle: safeTreatment.caseStyle,
    ...(safeTreatment.heroDisplay ? { presentation: "hero_display" } : {}),
    readability: { mode: "target_aware" },
    runs: [{ text: title.text, font: safeTreatment.font, size: safeTreatment.size, color: safeTreatment.color, weight: safeTreatment.weight }]
  };
  const operations = titles.length
    ? plan.operations.map((operation) => operation.type === "title" ? resolved : operation)
    : [...(plan?.operations || []), resolved];
  return { ...(plan || { version: "1" }), operations };
}

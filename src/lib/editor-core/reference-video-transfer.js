import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";
import { deriveReferenceStyleTreatment, validateReferenceStyleAnalysis } from "@/lib/editor-core/reference-style-matching";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { parseTitle } from "@/lib/title-parser";

export const REFERENCE_VIDEO_TRANSFER_VERSION = 1;

const PHOTO_FIELDS = Object.freeze(["palette", "exposure", "contrast", "saturation", "texture"]);
const PHOTO_VALUES = Object.freeze({ palette: ["warm", "cool", "neutral", "mixed"], exposure: ["low", "medium", "high"], contrast: ["low", "medium", "high"], saturation: ["low", "medium", "high"], texture: ["clean", "soft", "grain"] });
const DIAGNOSTIC_STATES = Object.freeze(["applied", "adapted", "needs_evidence", "unsupported", "rejected"]);

export class ReferenceVideoTransferError extends Error {
  constructor(reason, message = "This reference-video treatment cannot be applied safely.") {
    super(message); this.name = "ReferenceVideoTransferError"; this.reason = reason;
  }
}

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exactObject(value, fields) { if (!plainObject(value) || Object.keys(value).some((field) => !fields.includes(field))) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); return value; }
function ids(value, field) { if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !id) || new Set(value).size !== value.length) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE", `Invalid ${field}.`); return Object.freeze([...value]); }
function fraction(value, field) { if (!Number.isFinite(value) || value < 0 || value > 1) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE", `Invalid ${field}.`); return value; }

function validatePhotographicRecord(value) {
  if (!plainObject(value) || !PHOTO_FIELDS.includes(value.field)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const record = exactObject(value, ["field", "value", value.field, "state", "observationIds", "frameIds", "shotIds", "sampledFrameCount", "coverage", "observedCoverage"]);
  if (!PHOTO_VALUES[record.field].includes(record.value) || record[record.field] !== record.value || !["persistent", "provisional"].includes(record.state) || !Number.isInteger(record.sampledFrameCount) || record.sampledFrameCount < 1) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const observationIds = ids(record.observationIds, "observationIds"); const frameIds = ids(record.frameIds, "frameIds"); const shotIds = ids(record.shotIds, "shotIds");
  if (record.sampledFrameCount !== frameIds.length) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE", "sampledFrameCount must equal unique frame IDs.");
  const coverage = fraction(record.coverage, "coverage"); const observedCoverage = fraction(record.observedCoverage, "observedCoverage");
  if (record.state === "persistent" && (coverage < 0.55 || frameIds.length < 2)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE", "Persistent evidence needs repeated sampled support.");
  return Object.freeze({ field: record.field, value: record.value, [record.field]: record.value, state: record.state, observationIds, frameIds, shotIds, sampledFrameCount: record.sampledFrameCount, coverage, observedCoverage });
}

function validateTypographyEntry(value) {
  const entry = exactObject(value, ["observationId", "start", "end", "prominence", "fontCharacter", "weight", "position", "alignment", "colorCharacter"]);
  if (typeof entry.observationId !== "string" || !entry.observationId || !Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.start < 0 || entry.end <= entry.start || !["low", "medium", "high"].includes(entry.prominence) || !["serif", "sans", "display", "handwritten"].includes(entry.fontCharacter) || !["light", "regular", "bold"].includes(entry.weight) || !["top", "center", "bottom", "corner"].includes(entry.position) || !["left", "center", "right"].includes(entry.alignment) || !["light", "dark", "warm", "cool", "mixed"].includes(entry.colorCharacter)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  return Object.freeze({ ...entry });
}

/** Strict validation of the RV-1 aggregate artifact supplied by a trusted worker boundary. */
function recordKey(record) { return `${record.field}:${record.value}`; }
function sameRecord(left, right) { return left && right && left.state === right.state && left.coverage === right.coverage && left.observedCoverage === right.observedCoverage && left.sampledFrameCount === right.sampledFrameCount && JSON.stringify(left.observationIds) === JSON.stringify(right.observationIds) && JSON.stringify(left.frameIds) === JSON.stringify(right.frameIds) && JSON.stringify(left.shotIds) === JSON.stringify(right.shotIds); }
function assertKnownIds(records, provenance) {
  if (!provenance) return;
  const known = (field) => new Set(provenance[field] || []);
  if (!plainObject(provenance) || ["observationIds", "frameIds", "shotIds"].some((field) => !Array.isArray(provenance[field]) || known(field).size !== provenance[field].length)) throw new ReferenceVideoTransferError("RV2A_INVALID_PROVENANCE");
  for (const record of records) for (const field of ["observationIds", "frameIds", "shotIds"]) if (record[field].some((id) => !known(field).has(id))) throw new ReferenceVideoTransferError("RV2A_INVALID_PROVENANCE");
}

export function validateReferenceVideoCreativeSignature(value, { provenance = null } = {}) {
  const signature = exactObject(value, ["version", "evidenceVersion", "confidence", "photographic", "typography", "composition", "rhythm", "transitions"]);
  if (signature.version !== 1 || signature.evidenceVersion !== 1) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const confidence = exactObject(signature.confidence, ["completeEvidence", "eventCoverageComplete", "observedCoverage", "incompleteObservationCoverage", "observationCount", "conflicts"]);
  if (typeof confidence.completeEvidence !== "boolean" || typeof confidence.eventCoverageComplete !== "boolean" || typeof confidence.incompleteObservationCoverage !== "boolean" || !Number.isInteger(confidence.observationCount) || confidence.observationCount < 0 || !Array.isArray(confidence.conflicts) || confidence.conflicts.some((entry) => typeof entry !== "string")) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const photographic = exactObject(signature.photographic, ["persistent", "characteristics", "provisional", "sceneSpecific"]);
  for (const field of ["persistent", "characteristics", "provisional", "sceneSpecific"]) if (!Array.isArray(photographic[field])) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const persistent = photographic.persistent.map(validatePhotographicRecord);
  const characteristics = photographic.characteristics.map(validatePhotographicRecord);
  const provisional = photographic.provisional.map(validatePhotographicRecord);
  if (persistent.some((entry) => entry.state !== "persistent") || provisional.some((entry) => entry.state !== "provisional")) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  if (new Set(characteristics.map(recordKey)).size !== characteristics.length || new Set(persistent.map(recordKey)).size !== persistent.length || new Set(provisional.map(recordKey)).size !== provisional.length) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const characteristicByKey = new Map(characteristics.map((entry) => [recordKey(entry), entry]));
  for (const entry of [...persistent, ...provisional]) if (!sameRecord(entry, characteristicByKey.get(recordKey(entry)))) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const conflictingPersistentFields = [...new Set(persistent.map((entry) => entry.field).filter((field) => persistent.filter((entry) => entry.field === field).length > 1))];
  if (conflictingPersistentFields.length || new Set(confidence.conflicts).size !== confidence.conflicts.length || confidence.conflicts.some((entry) => !conflictingPersistentFields.includes(entry.replace(/^persistent_|_conflict$/g, "")))) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  if (confidence.incompleteObservationCoverage !== (confidence.observedCoverage < 0.75) || characteristics.some((entry) => entry.coverage > confidence.observedCoverage + 0.0001) || confidence.observationCount < Math.max(0, ...characteristics.map((entry) => entry.observationIds.length))) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  assertKnownIds(characteristics, provenance);
  const sceneSpecific = photographic.sceneSpecific.map((entry) => { const record = exactObject(entry, ["observationId", "shotId", "palette", "start", "end"]); if (typeof record.observationId !== "string" || typeof record.shotId !== "string" || !PHOTO_VALUES.palette.includes(record.palette) || !Number.isFinite(record.start) || !Number.isFinite(record.end) || record.start < 0 || record.end <= record.start) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); return Object.freeze({ ...record }); });
  const typography = exactObject(signature.typography, ["opening", "closing", "sustained", "recurring", "sceneSpecific"]);
  const normalizedTypography = Object.freeze(Object.fromEntries(Object.entries(typography).map(([kind, entries]) => { if (!Array.isArray(entries)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); return [kind, Object.freeze(entries.map(validateTypographyEntry))]; })));
  if (!Array.isArray(signature.composition) || !plainObject(signature.rhythm) || !Array.isArray(signature.rhythm.segments) || !Array.isArray(signature.transitions)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
  const composition = signature.composition.map((entry) => {
    const record = exactObject(entry, ["field", "recurring", "sceneSpecific"]);
    if (!["framing", "balance", "titleSafeArea", "subjectPlacement", "negativeSpace"].includes(record.field) || !Array.isArray(record.recurring) || !Array.isArray(record.sceneSpecific)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE");
    for (const recurring of record.recurring) { const item = exactObject(recurring, ["value", "observationIds", "shotIds", "coverage"]); if (typeof item.value !== "string") throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); ids(item.observationIds, "composition observationIds"); ids(item.shotIds, "composition shotIds"); fraction(item.coverage, "composition coverage"); }
    for (const scene of record.sceneSpecific) { const item = exactObject(scene, ["observationId", "shotId", "value"]); if (typeof item.observationId !== "string" || typeof item.shotId !== "string" || typeof item.value !== "string") throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); }
    return Object.freeze({ field: record.field, recurring: Object.freeze([...record.recurring]), sceneSpecific: Object.freeze([...record.sceneSpecific]) });
  });
  const rhythm = signature.rhythm.segments.map((entry) => { const segment = exactObject(entry, ["shotId", "start", "end", "duration", "pacing"]); if (typeof segment.shotId !== "string" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || !Number.isFinite(segment.duration) || segment.start < 0 || segment.end <= segment.start || Math.abs((segment.end - segment.start) - segment.duration) > 0.01 || !["unknown", "slow", "medium", "fast"].includes(segment.pacing)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); return Object.freeze({ ...segment }); });
  const transitions = signature.transitions.map((entry) => { const transition = exactObject(entry, ["shotId", "type"]); if (typeof transition.shotId !== "string" || !["unknown", "hard_cut"].includes(transition.type)) throw new ReferenceVideoTransferError("RV2A_INVALID_SIGNATURE"); return Object.freeze({ ...transition }); });
  return Object.freeze({ version: 1, evidenceVersion: 1, confidence: Object.freeze({ ...confidence, observedCoverage: fraction(confidence.observedCoverage, "observedCoverage"), conflicts: Object.freeze([...confidence.conflicts]) }), photographic: Object.freeze({ persistent: Object.freeze(persistent), characteristics: Object.freeze(characteristics), provisional: Object.freeze(provisional), sceneSpecific: Object.freeze(sceneSpecific) }), typography: normalizedTypography, composition: Object.freeze(composition), rhythm: Object.freeze({ segments: Object.freeze(rhythm) }), transitions: Object.freeze(transitions) });
}

function recordsByField(records) { return new Map(records.map((record) => [record.field, record])); }

/** Derives only observed RV-1 characteristics; B2A source facts are checked, never substituted. */
function referenceAppearanceFromSignature(signature, analysis, rawAnalysis) {
  const records = recordsByField(signature.photographic.characteristics.filter((entry) => entry.state === "persistent"));
  const palette = records.get("palette");
  if (!palette || !["warm", "cool", "neutral"].includes(palette.value) || signature.confidence.conflicts.includes("persistent_palette_conflict") || !signature.confidence.completeEvidence || !signature.confidence.eventCoverageComplete) return null;
  // Palette establishes only broad warmth. RV-1 does not prove a specific
  // cyan/yellow bias, tonal-band relationship, or highlight character.
  const paletteFacts = { warmth: palette.value };
  const supplied = analysis.reference;
  if (supplied.warmth !== paletteFacts.warmth) throw new ReferenceVideoTransferError("RV2A_REFERENCE_SIGNATURE_MISMATCH");
  // Missing RV-1 evidence must never become a synthetic `medium` reference
  // target. Using the target's value yields a zero delta for that unobserved
  // axis; the axis is then explicitly removed from the canonical recipe.
  const hasExposure = records.has("exposure");
  const hasSaturation = records.has("saturation");
  const hasContrast = records.has("contrast");
  const exposure = hasExposure ? records.get("exposure").value : analysis.target.exposure;
  const saturation = hasSaturation ? records.get("saturation").value : analysis.target.saturation;
  if (records.has("exposure") && supplied.exposure !== exposure) throw new ReferenceVideoTransferError("RV2A_REFERENCE_SIGNATURE_MISMATCH");
  if (records.has("saturation") && supplied.saturation !== saturation) throw new ReferenceVideoTransferError("RV2A_REFERENCE_SIGNATURE_MISMATCH");
  // Optional B2A fields are defaulted by its validator for backwards
  // compatibility. Only fields present in the pre-validation response are
  // independently observed facts; never mistake its defaults for RV-1 proof.
  const rawReference = plainObject(rawAnalysis?.reference) ? rawAnalysis.reference : {};
  const observed = (field, fallback) => Object.hasOwn(rawReference, field) ? supplied[field] : fallback;
  const rawObserved = (field) => Object.hasOwn(rawReference, field);
  const contrast = records.get("contrast")?.value;
  return Object.freeze({ reference: Object.freeze({
    context: observed("context", "mixed"), peopleOrSkin: supplied.peopleOrSkin,
    exposure, saturation, ...paletteFacts,
    ambientColorCharacter: observed("ambientColorCharacter", "neutral"),
    dominantColorBias: observed("dominantColorBias", "neutral"),
    shadowColorBias: observed("shadowColorBias", "neutral"), midtoneColorBias: observed("midtoneColorBias", "neutral"), highlightColorBias: observed("highlightColorBias", "neutral"),
    highlightCharacter: observed("highlightCharacter", "natural"), blackCharacter: observed("blackCharacter", "neutral"),
    saturationCharacter: observed("saturationCharacter", saturation === "high" ? "rich" : saturation === "low" ? "muted" : "natural"), colorSeparation: observed("colorSeparation", "neutral")
  }), adjustments: Object.freeze({ contrast: contrast === "high" ? 0.14 : contrast === "low" ? -0.1 : 0 }), authorizedAxes: Object.freeze({
    temperature: true,
    brightness: hasExposure,
    midtoneGamma: hasExposure,
    saturation: hasSaturation,
    vibrance: hasSaturation || rawObserved("saturationCharacter") || rawObserved("colorSeparation"),
    contrast: hasContrast || rawObserved("highlightCharacter") || rawObserved("colorSeparation"),
    shadows: rawObserved("blackCharacter"),
    blackLift: rawObserved("blackCharacter"),
    highlights: rawObserved("highlightCharacter"),
    tint: rawObserved("dominantColorBias"),
    shadowTemperature: rawObserved("shadowColorBias"),
    midtoneTemperature: rawObserved("midtoneColorBias"),
    highlightTemperature: rawObserved("highlightColorBias")
  }) });
}

function keepOnlyObservedPhotographicAxes(treatment, authorizedAxes) {
  const recipe = Object.fromEntries(Object.entries(treatment.recipe).map(([field, value]) => [field, authorizedAxes[field] ? value : 0]));
  return createCanonicalReferenceStyleTreatment({ version: treatment.version, recipe });
}

function applyObservedReferenceAdjustments(treatment, adjustments) {
  if (!adjustments.contrast) return treatment;
  return createCanonicalReferenceStyleTreatment({ version: treatment.version, recipe: {
    ...treatment.recipe,
    contrast: adjustments.contrast
  } });
}

function explicitTemperatureOverride(prompt) {
  const lower = String(prompt || "").toLowerCase();
  const warm = /\b(?:make|turn)\s+(?:the\s+)?(?:video|footage|image|it|this)?\s*(?:more\s+)?(?:warmer|warm|golden)\b|\bwarmer\b/.test(lower);
  const cool = /\b(?:make|turn)\s+(?:the\s+)?(?:video|footage|image|it|this)?\s*(?:more\s+)?(?:cooler|cool|teal)\b|\bcooler\b/.test(lower);
  if (warm && cool) throw new ReferenceVideoTransferError("RV2A_CONTRADICTORY_TEMPERATURE_OVERRIDE");
  return warm ? "warm" : cool ? "cool" : null;
}
function hasUnsupportedCentralRequest(prompt) { return /(?:exact(?:ly)?\s+(?:clone|match)|clone\s+(?:the\s+)?(?:transition|cut|composition)|(?:subject[- ]aware|reframe|refram(?:ing|e))|(?:same\s+)?camera\s+movements?|(?:match\s+)?(?:the\s+)?transitions?|(?:copy\s+)?(?:the\s+)?(?:editing\s+)?rhythm|(?:match|reconstruct|recreate)\s+(?:the\s+)?(?:cuts?|pacing|composition|shot\s+compositions?)|arbitrary\s+transition)/i.test(String(prompt || "")); }
function titleDurationFromPrompt(prompt) { const match = String(prompt || "").match(/\bfor\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b/i); return match ? Number(match[1]) : null; }
function titleClause(prompt) {
  const input = String(prompt || "");
  const match = /\b(?:add|show|put)\s+(?:(?:a|the)\s+)?title\b/i.exec(input);
  if (!match) return "";
  let quote = null;
  const closingQuote = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  for (let index = match.index; index < input.length; index += 1) {
    const character = input[index];
    if (quote) { if (character === quote) quote = null; continue; }
    if (closingQuote[character]) { quote = closingQuote[character]; continue; }
    if (character === "." || character === ";") return input.slice(match.index, index);
  }
  return input.slice(match.index);
}
function hasExplicitTitleText(clause) { return /\b(?:add|show|put)\s+(?:(?:a|the)\s+)?title\s+(?:(?:"[^"]+"|'[^']+'|“[^”]*”|‘[^’]*’)|(?:saying|:)\s*\S)/i.test(clause) || (/\b(?:add|show|put)\s+(?:(?:a|the)\s+)?title\s+(?!like\b|style\b|from\b|inspired\b)(\S+)/i.test(clause) && !/\breference\b/i.test(clause)); }
function hasExplicitTitleTime(prompt) { return /\bat\s+\d+:\d+\b/i.test(String(prompt || "")); }
function titleStylePrompt(prompt) { return String(prompt).replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g, (match) => " ".repeat(match.length)); }
function hasExplicitTitlePosition(prompt) { return /\b(?:top|bottom|center)(?:[-\s](?:left|center|right))?\b/i.test(titleStylePrompt(prompt)); }
function hasExplicitTitleColor(prompt) { return /#[0-9a-f]{6}\b|\b(?:white|black|yellow|red|blue|green|orange|purple|pink)\b/i.test(titleStylePrompt(prompt)); }
function hasExplicitTitleFont(prompt) { return /\b(?:inter|instrument\s+serif|jetbrains\s+mono|barlow)\b/i.test(titleStylePrompt(prompt)); }
function hasExplicitTitleSize(prompt) { return /\b(?:small|medium|large|\d{1,3}px)\b/i.test(titleStylePrompt(prompt)); }
function hasExplicitTitleWeight(prompt) { return /\b(?:bold|regular)\b/i.test(titleStylePrompt(prompt)); }

function referenceTitleStyle(signature) {
  const opening = signature.typography.opening[0]; const closing = !opening && signature.typography.closing[0]; const evidence = opening || closing || signature.typography.sustained[0] || signature.typography.recurring[0];
  if (!evidence) return null;
  return Object.freeze({ font: evidence.fontCharacter === "serif" ? "instrumentSerif" : evidence.fontCharacter === "display" ? "barlowCondensed" : "inter", weight: evidence.weight === "bold" ? "bold" : "regular", size: evidence.prominence === "high" ? "large" : "medium", position: evidence.position === "top" ? "top-center" : evidence.position === "bottom" ? "bottom-center" : "center", color: evidence.colorCharacter === "warm" ? "#F6DFB7" : evidence.colorCharacter === "cool" ? "#D7E8FF" : "#FFFFFF", timing: closing ? "closing" : "opening", evidence: Object.freeze({ observationIds: Object.freeze([evidence.observationId]) }) });
}

function buildTitleOperation({ prompt, signature, duration }) {
  const clause = titleClause(prompt);
  if (!hasExplicitTitleText(clause)) return null;
  const requested = parseTitle(clause, { stripQuotedText: true });
  if (!requested) return null;
  if (requested.font === "__unavailable__") throw new ReferenceVideoTransferError("RV2A_UNSUPPORTED_TITLE_FONT");
  const style = referenceTitleStyle(signature); const explicitTime = hasExplicitTitleTime(clause); const explicitDuration = titleDurationFromPrompt(clause);
  if (explicitDuration !== null && (!Number.isFinite(explicitDuration) || explicitDuration <= 0 || explicitDuration > duration)) throw new ReferenceVideoTransferError("RV2A_INVALID_TITLE_TIMING");
  const start = !explicitTime && style?.timing === "closing" ? Math.max(0, duration - (explicitDuration ?? 3)) : requested.start;
  const requestedDuration = explicitDuration ?? Math.min(3, duration - start); const end = start + requestedDuration;
  if (end > duration + 0.001) throw new ReferenceVideoTransferError("RV2A_INVALID_TITLE_TIMING");
  return Object.freeze({ type: "title", text: requested.text, start, end, position: style && !hasExplicitTitlePosition(clause) ? style.position : requested.position, size: style && !hasExplicitTitleSize(clause) ? style.size : requested.size, color: style && !hasExplicitTitleColor(clause) ? style.color : requested.color, weight: style && !hasExplicitTitleWeight(clause) ? style.weight : requested.weight, font: style && !hasExplicitTitleFont(clause) ? style.font : requested.font, ...(style ? { referenceEvidence: style.evidence } : {}) });
}

function diagnostic(kind, state, details = {}) { if (!DIAGNOSTIC_STATES.includes(state)) throw new ReferenceVideoTransferError("RV2A_INTERNAL_DIAGNOSTIC"); return Object.freeze({ kind, state, ...details }); }
function validSingleTarget(sourceCatalog) { if (!Array.isArray(sourceCatalog) || sourceCatalog.length !== 1) throw new ReferenceVideoTransferError("RV2A_EXACTLY_ONE_TARGET"); const target = sourceCatalog[0]; if (!target || typeof target.sourceId !== "string" || !target.sourceId || !Number.isFinite(target.duration) || target.duration <= 0) throw new ReferenceVideoTransferError("RV2A_INVALID_TARGET"); return target; }
function validateBasePlan(basePlan, sourceCatalog) { const plan = basePlan || { version: "1", operations: [] }; validateEditPlan(plan, { sourceCatalog }); return { version: plan.version, operations: [...plan.operations] }; }
function requestsPhotographicReferenceMatch(prompt) { return /\b(?:match|look(?:s)?\s+like|reference[-\s]?inspired|photographically)\b[\s\S]{0,48}\b(?:reference|style|look)\b|\b(?:reference|style)\b[\s\S]{0,48}\b(?:match|look(?:s)?\s+like|photographically)\b/i.test(String(prompt || "")); }
function applyExplicitTemperatureOverride(treatment, direction, target) {
  if (!direction) return treatment;
  const sign = direction === "warm" ? 1 : -1;
  const hueCap = target.peopleOrSkin ? 0.075 : 0.13;
  const bandCap = target.peopleOrSkin ? 0.055 : 0.1;
  const minimum = target.peopleOrSkin ? 0.055 : 0.085;
  const recipe = treatment.recipe;
  const magnitude = Math.min(hueCap, Math.max(minimum, Math.abs(recipe.temperature || 0)));
  const band = (value) => sign * Math.min(bandCap, Math.max(0, Math.abs(value || 0)));
  return createCanonicalReferenceStyleTreatment({ version: treatment.version, recipe: {
    ...recipe,
    temperature: sign * magnitude,
    shadowTemperature: band(recipe.shadowTemperature),
    midtoneTemperature: band(recipe.midtoneTemperature),
    highlightTemperature: band(recipe.highlightTemperature)
  } });
}

/** Internal RV-2A reconciliation; reference media is never a renderer source. */
export function createReferenceVideoTargetAwareTreatment({ signature, targetAnalysis, targetMetrics, prompt, sourceCatalog, reference, basePlan, provenance } = {}) {
  if (!reference || reference.kind !== "video" || reference.signatureVersion !== 1 || reference.evidenceVersion !== 1) throw new ReferenceVideoTransferError("RV2A_REFERENCE_REQUIRED");
  const target = validSingleTarget(sourceCatalog); const safeSignature = validateReferenceVideoCreativeSignature(signature, { provenance });
  if (hasUnsupportedCentralRequest(prompt)) throw new ReferenceVideoTransferError("RV2A_UNSUPPORTED_CENTRAL_CHARACTERISTIC");
  const safeTargetAnalysis = validateReferenceStyleAnalysis(targetAnalysis); const plan = validateBasePlan(basePlan, sourceCatalog); const diagnostics = [];
  const photoReference = referenceAppearanceFromSignature(safeSignature, safeTargetAnalysis, targetAnalysis); const explicitTemperature = explicitTemperatureOverride(prompt);
  if (photoReference) {
    const derivedAnalysis = { safe: true, reference: photoReference.reference, target: safeTargetAnalysis.target };
    let treatment = applyObservedReferenceAdjustments(
      keepOnlyObservedPhotographicAxes(deriveReferenceStyleTreatment({ analysis: derivedAnalysis, metrics: targetMetrics }), photoReference.authorizedAxes),
      photoReference.adjustments
    );
    if (explicitTemperature) { treatment = applyExplicitTemperatureOverride(treatment, explicitTemperature, safeTargetAnalysis.target); diagnostics.push(diagnostic("photography", "adapted", { reason: "explicit_user_temperature_override", direction: explicitTemperature, evidence: safeSignature.photographic.persistent.map((entry) => entry.observationIds) })); }
    else diagnostics.push(diagnostic("photography", "applied", { evidence: safeSignature.photographic.persistent.map((entry) => entry.observationIds) }));
    if (plan.operations.some((operation) => ["style_profile", "color_grade", "reference_style_treatment"].includes(operation.type))) throw new ReferenceVideoTransferError("RV2A_CONFLICTING_VISUAL_TREATMENT");
    plan.operations.push({ type: "reference_style_treatment", treatment });
  } else {
    diagnostics.push(diagnostic("photography", "needs_evidence", { completion: "incomplete", reason: "no_complete_nonconflicting_persistent_palette" }));
    if (requestsPhotographicReferenceMatch(prompt)) throw new ReferenceVideoTransferError("RV2A_NO_SUPPORTED_TREATMENT");
  }
  if (safeSignature.photographic.sceneSpecific.length) diagnostics.push(diagnostic("scene_specific_photography", "needs_evidence", { reason: "global_renderer_cannot_flatten_scene_specific_reference_treatment" }));
  const title = buildTitleOperation({ prompt, signature: safeSignature, duration: target.duration });
  if (title) { if (plan.operations.some((operation) => operation.type === "title")) throw new ReferenceVideoTransferError("RV2A_CONFLICTING_TITLE"); const { referenceEvidence, ...operation } = title; plan.operations.push(operation); diagnostics.push(diagnostic("typography", referenceEvidence ? "adapted" : "applied", referenceEvidence ? { evidence: referenceEvidence } : { reason: "user_authorized_title_without_reference_typography" })); }
  else if (referenceTitleStyle(safeSignature)) diagnostics.push(diagnostic("typography", "needs_evidence", { reason: "no_user_authorized_title_text" }));
  if (!title && /\b(?:title|typography)\b[\s\S]{0,48}\b(?:reference|style)\b/i.test(String(prompt || ""))) throw new ReferenceVideoTransferError("RV2A_NO_SUPPORTED_TREATMENT");
  if (!plan.operations.length) throw new ReferenceVideoTransferError("RV2A_NO_SUPPORTED_TREATMENT");
  validateEditPlan(plan, { sourceCatalog });
  return Object.freeze({ version: REFERENCE_VIDEO_TRANSFER_VERSION, plan: Object.freeze({ version: plan.version, operations: Object.freeze(plan.operations.map(Object.freeze)) }), diagnostics: Object.freeze(diagnostics), limitations: Object.freeze(["composition_requires_renderer_support", "rhythm_is_observational", "transition_cloning_unsupported", "scene_specific_grading_requires_future_renderer_support"]) });
}

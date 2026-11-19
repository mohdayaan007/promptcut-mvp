import { parseTitle } from "@/lib/title-parser";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fullSequence(sourceCatalog) { return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration })); }
function currentSequence(plan, sourceCatalog) { return clone(plan?.operations?.find((operation) => operation.type === "sequence")?.clips || fullSequence(sourceCatalog)); }

export function isUgcDirectorRequest(prompt = "") {
  return /\b(?:premium|luxury|luxurious)\b.*\b(?:skincare|product|advertisement|ad)\b|\b(?:create|make)\b.*\b(?:skincare|product)\s+(?:advertisement|ad)\b/i.test(prompt);
}

export function isUgcDirectorFollowUp(prompt = "", priorPlan = null) {
  const hasDirectorTreatment = priorPlan?.operations?.some((operation) => operation.type === "crop" && operation.aspect_ratio === "9:16")
    && priorPlan?.operations?.some((operation) => operation.type === "color_grade" && operation.style === "cinematic");
  // A creator may make precise cuts/title decisions first, then ask the
  // Director for the premium pass. A title plus a concrete sequence is enough
  // context to keep that request in the same durable session; an arbitrary
  // ordinary edit is not silently promoted to a Director request.
  const hasDirectedContext = hasDirectorTreatment || (
    priorPlan?.operations?.some((operation) => operation.type === "sequence") &&
    priorPlan?.operations?.some((operation) => operation.type === "title")
  );
  if (!hasDirectedContext) return false;
  return /\b(?:premium|luxury|luxurious)\b|\bimprove\s+(?:the\s+)?(?:pacing|product\s+ad|advertisement)\b/i.test(prompt);
}

export function isUgcTitleRevisionRequest(prompt = "", priorPlan = null) {
  const hasLiteralTitle = /\b(?:add|show|put)\s+(?:the\s+)?title\s+(?:["'“‘]|saying\b)|\b(?:title|headline|text)\s*:/i.test(prompt);
  return hasLiteralTitle && Boolean(priorPlan?.operations?.some((operation) => operation.type === "title"))
    && /\b(?:title|headline|text|typography|font)\b/i.test(prompt)
    && /\b(?:change|update|revise|style|font|title)\b/i.test(prompt);
}

export function isAmbiguousUgcTitleRevision(prompt = "", priorPlan = null) {
  const hasTitle = Boolean(priorPlan?.operations?.some((operation) => operation.type === "title"));
  const asksForTitleChange = /\b(?:change|update|revise|style)\b.*\b(?:title|headline|text|typography|font)\b|\b(?:title|headline|text|typography|font)\b.*\b(?:change|update|revise|style)\b/i.test(prompt);
  return hasTitle && asksForTitleChange && !isUgcTitleRevisionRequest(prompt, priorPlan);
}

/** Server policy, not a model aesthetic claim: evidence chooses footage; this composes only renderer-supported UGC treatments. */
export function createUgcDirectorPlan({ priorPlan = null, sourceCatalog, evidence, prompt, locked = [] }) {
  const selected = evidence?.productClips;
  if (!Array.isArray(selected) || !selected.length) throw new Error("I need verified product-shot evidence before I can direct this edit.");
  const prior = currentSequence(priorPlan, sourceCatalog);
  const clips = locked.includes("sequence")
    ? prior
    : selected.flatMap((candidate) => prior.filter((clip) => clip.sourceId === candidate.sourceId).map((clip) => ({ sourceId: clip.sourceId, start: Math.max(clip.start, candidate.start), end: Math.min(clip.end, candidate.end) })).filter((clip) => clip.end > clip.start));
  const duration = clips.reduce((total, clip) => total + clip.end - clip.start, 0);
  if (duration < 15 || duration > 45) throw new Error("Verified product footage must support a 15–45 second UGC edit.");
  const preserved = (priorPlan?.operations || []).filter((operation) => !["sequence", "trim", "merge", "title", "color_grade", "crop"].includes(operation.type));
  const titleLocked = locked.includes("title");
  const title = titleLocked ? priorPlan?.operations?.find((operation) => operation.type === "title") : parseTitle(prompt);
  const operations = [{ type: "sequence", clips }, { type: "crop", aspect_ratio: "9:16" }, { type: "color_grade", style: "cinematic" }, ...preserved];
  if (title) operations.push({ type: "title", ...title });
  return validateEditPlan({ version: "2", operations }, { sourceCatalog });
}

export function reviseUgcTitle({ plan, prompt, sourceCatalog }) {
  const parsed = parseTitle(prompt, { stripQuotedText: true });
  if (!parsed) throw new Error("Include the replacement title text and supported styling.");
  const next = clone(plan);
  const existing = next.operations.findIndex((operation) => operation.type === "title");
  if (existing < 0) throw new Error("There is no existing title to revise.");
  // Recommendations can include browser-preview-only catalogue fonts. Keep an
  // already validated export font until an explicit export-ready font is named.
  const safeParsed = (parsed.fontIntent || parsed.font === "__unavailable__")
    ? { ...parsed, font: next.operations[existing].font, fontIntent: undefined }
    : parsed;
  const priorTitle = next.operations[existing];
  // Runs are an exact rich-text representation of their title. A replacement
  // title cannot retain the old character runs; a styling-only revision keeps
  // them untouched so mixed-font title work remains intact.
  const replacement = { ...priorTitle, ...safeParsed };
  if (safeParsed.text !== priorTitle.text) delete replacement.runs;
  next.operations[existing] = replacement;
  return validateEditPlan(next, { sourceCatalog });
}

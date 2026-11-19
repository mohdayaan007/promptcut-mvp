import { parseTitle } from "@/lib/title-parser";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fullSequence(sourceCatalog) { return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration })); }
function currentSequence(plan, sourceCatalog) { return clone(plan?.operations?.find((operation) => operation.type === "sequence")?.clips || fullSequence(sourceCatalog)); }

/** Server policy, not a model aesthetic claim: evidence chooses footage; this composes only renderer-supported UGC treatments. */
export function createUgcDirectorPlan({ priorPlan = null, sourceCatalog, evidence, prompt, locked = [] }) {
  const selected = evidence?.productClips;
  if (!Array.isArray(selected) || !selected.length) throw new Error("I need verified product-shot evidence before I can direct this edit.");
  const prior = currentSequence(priorPlan, sourceCatalog);
  const clips = selected.flatMap((candidate) => prior.filter((clip) => clip.sourceId === candidate.sourceId).map((clip) => ({ sourceId: clip.sourceId, start: Math.max(clip.start, candidate.start), end: Math.min(clip.end, candidate.end) })).filter((clip) => clip.end > clip.start));
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
  const parsed = parseTitle(prompt);
  if (!parsed) throw new Error("Include the replacement title text and supported styling.");
  const next = clone(plan);
  const existing = next.operations.findIndex((operation) => operation.type === "title");
  if (existing < 0) throw new Error("There is no existing title to revise.");
  // Recommendations can include browser-preview-only catalogue fonts. Keep an
  // already validated export font until an explicit export-ready font is named.
  const safeParsed = (parsed.fontIntent || parsed.font === "__unavailable__")
    ? { ...parsed, font: next.operations[existing].font, fontIntent: undefined }
    : parsed;
  next.operations[existing] = { ...next.operations[existing], ...safeParsed };
  return validateEditPlan(next, { sourceCatalog });
}

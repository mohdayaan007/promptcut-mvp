import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";

const STYLE_TYPES = new Set(["color_grade", "style_profile", "visual_adjustment", "reference_style_treatment"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fullSequence(sourceCatalog) {
  return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration }));
}

/** Removes a time interval from a source-relative sequence without ever using an export as input. */
export function trimOutputStart(plan, seconds, sourceCatalog) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("The trim duration must be positive");
  const next = clone(plan || { version: sourceCatalog.length > 1 ? "2" : "1", operations: [] });
  let sequence = next.operations.find((operation) => operation.type === "sequence");
  if (!sequence) {
    sequence = { type: "sequence", clips: fullSequence(sourceCatalog) };
    next.version = "2";
    next.operations.unshift(sequence);
  }
  let remaining = seconds;
  const clips = [];
  for (const clip of sequence.clips) {
    const duration = clip.end - clip.start;
    if (remaining >= duration) { remaining -= duration; continue; }
    clips.push({ ...clip, start: clip.start + remaining });
    remaining = 0;
  }
  if (!clips.length) throw new Error("That trim would remove the entire video");
  sequence.clips = clips;
  return next;
}

function resetStyle(plan) {
  return { ...clone(plan), operations: plan.operations.filter((operation) => !STYLE_TYPES.has(operation.type)) };
}

/**
 * Applies only deliberately unambiguous conversational deltas locally. More
 * expressive turns remain on the existing Gemini planner path for the first
 * turn; this guarantees style replacement and output-relative trims.
 */
export function applyConversationTurn({ priorPlan, prompt, sourceCatalog }) {
  const text = String(prompt || "").trim();
  if (!text) throw new Error("Enter an editing instruction");
  const normalized = text.toLowerCase();
  if (/\b(?:bring|change|turn)\s+(?:it\s+)?back\s+to\s+normal\b|\bremove\s+(?:the\s+)?(?:style|filter)\b/.test(normalized)) {
    return { plan: resetStyle(priorPlan), confirmation: "Restored the original color treatment while keeping your earlier edits." };
  }
  const firstTrim = normalized.match(/(?:trim|remove|cut)\s+(?:the\s+)?first\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?/);
  if (firstTrim) {
    if (priorPlan.operations.some((operation) => operation.type === "speed")) {
      throw new Error("Trimming after a speed change is not supported yet. Remove the speed change or make the trim first.");
    }
    const spelled = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const seconds = spelled[firstTrim[1]] || Number(firstTrim[1]);
    const plan = trimOutputStart(priorPlan, seconds, sourceCatalog);
    return { plan, confirmation: `Trimmed the first ${seconds} seconds from the current edit.` };
  }
  const style = /\bblack\s*(?:and|&)\s*white\b|\bgrayscale\b/.test(normalized)
    ? { type: "color_grade", style: "bw" }
    : /\bcinematic\b/.test(normalized) ? { type: "color_grade", style: "cinematic" }
      : null;
  if (style) {
    const plan = resetStyle(priorPlan);
    plan.operations.push(style);
    return { plan, confirmation: style.style === "bw" ? "Applied black and white." : "Replaced the previous look with the cinematic style." };
  }
  // This deterministic fallback is intentionally limited. It preserves prior
  // state for simple known commands; unsupported ambiguity is rejected safely.
  const generated = createEditPlan({ prompt: text, hasMultipleVideos: sourceCatalog.length > 1, sourceCatalog });
  if (!generated.operations?.length) throw new Error("I couldn’t safely apply that change to the current edit.");
  return { plan: { ...clone(priorPlan), operations: [...priorPlan.operations, ...generated.operations] }, confirmation: "Applied that change to the current edit." };
}

export function validateConversationPlan(plan, sourceCatalog) {
  return validateEditPlan(plan, { sourceCatalog });
}

import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";

const STYLE_TYPES = new Set(["color_grade", "style_profile", "visual_adjustment", "reference_style_treatment"]);
const REPLACE_ON_FOLLOW_UP_TYPES = new Set(["crop", "fade", "speed", "captions"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fullSequence(sourceCatalog) {
  return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration }));
}

function sliceSequence(clips, start, end = Infinity) {
  let offset = 0;
  return clips.flatMap((clip) => {
    const duration = clip.end - clip.start;
    const from = Math.max(0, start - offset);
    const to = Math.min(duration, end - offset);
    offset += duration;
    return to > from ? [{ ...clip, start: clip.start + from, end: clip.start + to }] : [];
  });
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
  // A legacy global trim acts on the assembled sequence. Canonicalize its
  // visible window before applying the new delta; keeping it would trim twice.
  const priorTrim = next.operations.find((operation) => operation.type === "trim");
  const visibleClips = priorTrim ? sliceSequence(sequence.clips, priorTrim.start, priorTrim.end) : sequence.clips;
  const clips = sliceSequence(visibleClips, seconds);
  if (!clips.length) throw new Error("That trim would remove the entire video");
  sequence.clips = clips;
  next.operations = next.operations.filter((operation) => !["trim", "merge"].includes(operation.type));
  return next;
}

function resetStyle(plan) {
  return { ...clone(plan), operations: plan.operations.filter((operation) => !STYLE_TYPES.has(operation.type)) };
}

function mergeSupportedFollowUp(priorPlan, operations) {
  const next = clone(priorPlan);
  for (const operation of operations) {
    if (operation.type === "trim" || operation.type === "sequence" || operation.type === "merge") {
      throw new Error("Use “trim the first N seconds” for a follow-up trim. Other timeline changes need fresh media understanding.");
    }
    if (STYLE_TYPES.has(operation.type)) next.operations = next.operations.filter((item) => !STYLE_TYPES.has(item.type));
    if (REPLACE_ON_FOLLOW_UP_TYPES.has(operation.type)) next.operations = next.operations.filter((item) => item.type !== operation.type);
    next.operations.push(operation);
  }
  return next;
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
  // These fast paths accept a complete instruction, never a matching fragment
  // of a compound/negated/source-scoped request that would silently lose intent.
  const simple = normalized.replace(/[.!]+$/g, "").replace(/^(?:now|also|please)\s+/, "");
  if (/\b(?:bring|change|turn)\s+(?:it\s+)?back\s+to\s+normal\b|\bremove\s+(?:the\s+)?(?:style|filter)\b/.test(normalized)) {
    if (!/^(?:(?:bring|change|turn)\s+(?:it\s+)?back\s+to\s+normal|remove\s+(?:the\s+)?(?:style|filter))$/.test(simple)) throw new Error("Please request one supported change at a time. Your current edit is unchanged.");
    return { plan: resetStyle(priorPlan), confirmation: "Restored the original color treatment while keeping your earlier edits." };
  }
  const firstTrim = normalized.match(/(?:trim|remove|cut)\s+(?:the\s+)?first\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?/);
  if (firstTrim) {
    if (!/^(?:trim|remove|cut)\s+(?:the\s+)?first\s+(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?(?:\s+too)?$/.test(simple)) throw new Error("Please request one supported change at a time. Your current edit is unchanged.");
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
    if (!/^(?:(?:add|apply)\s+(?:a\s+|the\s+)?|make\s+(?:it|this(?:\s+video)?|the\s+video|my\s+(?:video|footage))\s+|replace\s+(?:that|it|the\s+(?:look|style|filter))\s+with\s+(?:the\s+)?)?(?:black\s*(?:and|&)\s*white|grayscale|cinematic)(?:\s+(?:style|look|filter))?(?:\s+instead)?$/.test(simple)) throw new Error("Please request one supported style change at a time. Your current edit is unchanged.");
    const plan = resetStyle(priorPlan);
    plan.operations.push(style);
    return { plan, confirmation: style.style === "bw" ? "Applied black and white." : "Replaced the previous look with the cinematic style." };
  }
  if (/\b(?:remove|delete|turn off)\s+(?:the\s+)?(?:captions?|subtitles?|title|text)\b/.test(normalized)) {
    throw new Error("Removing captions or titles in a follow-up is not supported yet. Your current edit is unchanged.");
  }
  // This deterministic fallback is intentionally limited. It preserves prior
  // state for simple known commands; unsupported ambiguity is rejected safely.
  const generated = createEditPlan({ prompt: text, hasMultipleVideos: sourceCatalog.length > 1, sourceCatalog });
  if (!generated.operations?.length) throw new Error("I couldn’t safely apply that change to the current edit.");
  return { plan: mergeSupportedFollowUp(priorPlan, generated.operations), confirmation: "Applied that change to the current edit." };
}

export function validateConversationPlan(plan, sourceCatalog) {
  return validateEditPlan(plan, { sourceCatalog });
}

import { getIntentPattern, understandPrompt } from "@/lib/prompt-understanding";
import { parseTitle } from "@/lib/title-parser";

function detectColor(intents = []) {
  if (intents.includes("blackWhite")) return "bw";
  if (intents.includes("cinematic")) return "cinematic";
  if (intents.includes("cool")) return "blue";
  if (intents.includes("warm")) return "warm";
  return null;
}

function parseTrim(prompt = "", intents = []) {
  if (!intents.includes("trim")) return null;

  const match = prompt.match(
    new RegExp(`(?:${getIntentPattern("trim")}).*?(\\d+):(\\d+)\\s*to\\s*(\\d+):(\\d+)`, "i")
  );

  if (!match) return null;

  return {
    start: parseInt(match[1], 10) * 60 + parseInt(match[2], 10),
    end: parseInt(match[3], 10) * 60 + parseInt(match[4], 10)
  };
}

/**
 * Converts the current deterministic prompt parser into the edit-plan format.
 * A future interpretation layer can produce this same shape without changing
 * the validator or executor.
 */
export function createEditPlan({ prompt = "", hasSecondVideo = false }) {
  const { intents } = understandPrompt(prompt);
  const operations = [];
  const colorStyle = detectColor(intents);
  const trim = parseTrim(prompt, intents);
  const title = parseTitle(prompt);

  // Two uploaded clips have always been merged automatically, independent of
  // whether the prompt mentions merging. Preserve that established behavior.
  if (hasSecondVideo) operations.push({ type: "merge" });
  if (colorStyle) operations.push({ type: "color_grade", style: colorStyle });
  if (title) operations.push({ type: "title", ...title });
  if (trim) operations.push({ type: "trim", ...trim });

  return { version: "1", operations };
}

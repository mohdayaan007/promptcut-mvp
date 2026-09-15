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

function parseTimestampRange(prompt = "") {
  const match = prompt.match(/(\d+):(\d+)\s*(?:to|until|through)\s*(\d+):(\d+)/i);
  if (!match) return null;
  return {
    start: parseInt(match[1], 10) * 60 + parseInt(match[2], 10),
    end: parseInt(match[3], 10) * 60 + parseInt(match[4], 10)
  };
}

function parseFallbackCapabilities(prompt = "") {
  const operations = [];
  const range = parseTimestampRange(prompt);
  const speedMatch = prompt.match(/\b(0\.5|0\.75|1\.25|1\.5|2|3|4)\s*x\b/i);

  if (/\b(?:vertical|portrait|reel|tiktok)\b/i.test(prompt)) {
    operations.push({ type: "crop", aspect_ratio: "9:16" });
  } else if (/\bsquare\b/i.test(prompt)) {
    operations.push({ type: "crop", aspect_ratio: "1:1" });
  } else if (/\b(?:landscape|16:9)\b/i.test(prompt)) {
    operations.push({ type: "crop", aspect_ratio: "16:9" });
  }

  if (/\bfade\s+in\s+and\s+out\b/i.test(prompt)) {
    operations.push({ type: "fade", mode: "both", duration: 1 });
  } else if (/\bfade\s+out\b/i.test(prompt)) {
    operations.push({ type: "fade", mode: "out", duration: 1 });
  } else if (/\bfade\s+in\b/i.test(prompt)) {
    operations.push({ type: "fade", mode: "in", duration: 1 });
  }

  if (/\b(?:slow(?:\s+this)?\s+down|slow motion)\b/i.test(prompt)) {
    operations.push({ type: "speed", ...(range || {}), factor: 0.5 });
  } else if (speedMatch) {
    operations.push({ type: "speed", ...(range || {}), factor: parseFloat(speedMatch[1]) });
  } else if (/\b(?:speed(?:\s+this)?\s+up|faster)\b/i.test(prompt)) {
    operations.push({ type: "speed", ...(range || {}), factor: 2 });
  }

  if (/\bzoom\s+in\b/i.test(prompt)) {
    operations.push({ type: "zoom", ...(range || { start: 0, end: 3 }), amount: 1.15 });
  }

  return operations;
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
  operations.push(...parseFallbackCapabilities(prompt));

  return { version: "1", operations };
}

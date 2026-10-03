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

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

const ORDINAL_SOURCE_WORDS = /\b(?:first|second|third|fourth|fifth|video\s*\d+|source[-\s]?\d+)\b/i;
const NON_SEMANTIC_SOURCE_DESCRIPTORS = /^(?:this|that|uploaded|selected|use|then|put|start|finish|append|followed|with|make|turn|change|only|both|all|every|each|(?:make|turn|change)\s+(?:only|both|all|every|each))$/;

/**
 * Identifies a semantic source description that deterministic parsing must not
 * guess when Gemini visual analysis is unavailable.
 */
export function requiresVisualSourceUnderstanding(prompt = "", sourceCatalog = []) {
  if (sourceCatalog.length < 2) return false;
  const normalized = prompt.toLowerCase();
  const semanticPhrase = /\b(?:the\s+)?([a-z][a-z\s-]{1,48})\s+(?:video|clip|footage|shot)\b/g;
  for (const match of normalized.matchAll(semanticPhrase)) {
    const description = match[1].trim();
    if (!ORDINAL_SOURCE_WORDS.test(description) && !NON_SEMANTIC_SOURCE_DESCRIPTORS.test(description)) return true;
  }
  return /\bvideo\s+(?:showing|with|of)\b/i.test(normalized);
}

function sourceIdForOrdinal(ordinal) { return `source-${ordinal}`; }

function fullSourceClips(sourceCatalog) {
  return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration }));
}

function sourceAwareFallbackPlan(prompt, sourceCatalog, colorStyle) {
  if (!sourceCatalog.length) return null;
  const timedClips = [];
  const rangePattern = /seconds?\s+(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s+of\s+(?:video\s*|source[-\s]?)(\d+)/gi;
  const firstSecondsPattern = /first\s+(\d+(?:\.\d+)?)\s+seconds?\s+of\s+(?:video\s*|source[-\s]?)(\d+)/gi;
  for (const match of prompt.matchAll(firstSecondsPattern)) {
    timedClips.push({ index: match.index, sourceId: sourceIdForOrdinal(Number(match[2])), start: 0, end: Number(match[1]) });
  }
  for (const match of prompt.matchAll(rangePattern)) {
    timedClips.push({ index: match.index, sourceId: sourceIdForOrdinal(Number(match[3])), start: Number(match[1]), end: Number(match[2]) });
  }
  if (timedClips.length) {
    return { version: "2", operations: [{ type: "sequence", clips: timedClips.sort((left, right) => left.index - right.index).map(({ index, ...clip }) => clip) }] };
  }

  const references = [];
  const referencePattern = /\b(?:video\s*|source[-\s]?)(\d+)\b|\b(first|second|third|fourth|fifth)\s+video\b|\bthen\s+(?:the\s+)?(first|second|third|fourth|fifth)\b/gi;
  for (const match of prompt.matchAll(referencePattern)) {
    const ordinal = Number(match[1]) || ORDINALS[match[2]] || ORDINALS[match[3]];
    if (ordinal) references.push({ index: match.index, sourceId: sourceIdForOrdinal(ordinal) });
  }

  const sourceOnlyMatch = prompt.match(/\bonly\s+(?:video\s*|source[-\s]?)(\d+)\b/i);
  if (sourceOnlyMatch && colorStyle) {
    return {
      version: "2",
      operations: [
        { type: "sequence", clips: fullSourceClips(sourceCatalog) },
        { type: "color_grade", sourceId: sourceIdForOrdinal(Number(sourceOnlyMatch[1])), style: colorStyle }
      ]
    };
  }

  if (references.length) {
    return {
      version: "2",
      operations: [{ type: "sequence", clips: references.sort((left, right) => left.index - right.index).map((reference) => {
        const source = sourceCatalog.find((entry) => entry.sourceId === reference.sourceId);
        return { sourceId: reference.sourceId, start: 0, end: source?.duration || 1 };
      }) }]
    };
  }
  return null;
}

/**
 * Converts the current deterministic prompt parser into the edit-plan format.
 * A future interpretation layer can produce this same shape without changing
 * the validator or executor.
 */
export function createEditPlan({ prompt = "", hasSecondVideo = false, hasMultipleVideos = hasSecondVideo, sourceCatalog = [] }) {
  const { intents } = understandPrompt(prompt);
  const operations = [];
  const colorStyle = detectColor(intents);
  const trim = parseTrim(prompt, intents);
  const title = parseTitle(prompt);
  const sourceAwarePlan = sourceAwareFallbackPlan(prompt, sourceCatalog, colorStyle);
  if (sourceAwarePlan) return sourceAwarePlan;

  // Uploaded clips are merged automatically, independent of whether the prompt
  // mentions merging. Preserve the established multi-clip behavior.
  if (hasMultipleVideos) operations.push({ type: "merge" });
  if (colorStyle) operations.push({ type: "color_grade", style: colorStyle });
  if (title) operations.push({ type: "title", ...title });
  if (trim) operations.push({ type: "trim", ...trim });
  operations.push(...parseFallbackCapabilities(prompt));

  return { version: "1", operations };
}

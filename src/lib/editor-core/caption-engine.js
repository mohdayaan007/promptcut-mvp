import { normalizePhrase } from "@/lib/editor-core/spoken-transcript";
import { COLOR_MAP, FONT_CATALOG, normalizeTitleColor, normalizeTitlePosition, POSITION_MAP } from "@/lib/title-config";

const MAX_WORDS = 8;
const MAX_CHARACTERS = 48;
const MAX_DURATION = 5;
const PAUSE_SECONDS = 0.65;

export class CaptionError extends Error {}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Extracts only explicit, renderer-supported caption styling from the prompt. */
export function extractCaptionStyleRequest(prompt = "") {
  const style = {};
  const text = String(prompt);
  const fontAliases = Object.values(FONT_CATALOG)
    .flatMap((font) => [font.id, font.family, ...font.aliases].map((alias) => ({ alias, font: font.id })))
    .sort((left, right) => right.alias.length - left.alias.length);
  const font = fontAliases.find(({ alias }) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text));
  if (font) style.font = font.font;

  const hex = text.match(/#[0-9a-f]{6}\b/i)?.[0];
  if (hex) style.color = normalizeTitleColor(hex);
  if (!style.color) {
    const namedColors = Object.keys(COLOR_MAP).join("|");
    const named = text.match(new RegExp(`\\b(?:using|with|in|color|colour)\\s+(${namedColors})\\b|\\b(${namedColors})\\s+(?:subtitles?|captions?|text)\\b`, "i"));
    if (named) style.color = normalizeTitleColor(named[1] || named[2]);
  }

  if (/\b(?:small|smaller)\s+(?:text|subtitles?|captions?)\b|\b(?:text|subtitles?|captions?)\s+(?:small|smaller)\b/i.test(text)) style.size = "small";
  else if (/\b(?:large|larger)\s+(?:text|subtitles?|captions?)\b|\b(?:text|subtitles?|captions?)\s+(?:large|larger)\b/i.test(text)) style.size = "large";
  else if (/\bmedium\s+(?:text|subtitles?|captions?)\b|\b(?:text|subtitles?|captions?)\s+medium\b/i.test(text)) style.size = "medium";

  const positions = Object.keys(POSITION_MAP).sort((left, right) => right.length - left.length);
  const position = positions.find((value) => new RegExp(`\\b${escapeRegExp(value).replace(/-/g, "[-\\s]+")}\\b`, "i").test(text));
  if (position) style.position = normalizeTitlePosition(position);

  const weight = text.match(/\b(bold|regular)\b/i)?.[1]?.toLowerCase();
  if (weight) style.weight = weight;
  return style;
}

export function createCaptionOperation(prompt = "") {
  return { type: "captions", ...extractCaptionStyleRequest(prompt) };
}

/** Ensures a prompt-authorized caption operation survives AI planning. */
export function reconcileCaptionOperation(plan, prompt = "") {
  if (!requestsCaptions(prompt)) return plan;
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const aiCaption = operations.find((operation) => operation?.type === "captions");
  const explicitStyle = extractCaptionStyleRequest(prompt);
  const caption = { ...createCaptionOperation(prompt), ...aiCaption, ...explicitStyle };
  if (explicitStyle.font) delete caption.fontIntent;
  return { ...plan, operations: [...operations.filter((operation) => operation?.type !== "captions"), caption] };
}

function sentenceEnd(word) { return /[.!?](?:[\]"')}]*)$/.test(word.text); }

/** Builds short, readable server-owned cues from canonical transcript words. */
export function createCaptionCues(transcript) {
  const words = transcript?.segments?.flatMap((segment) => segment.words) || [];
  const cues = [];
  let current = [];
  for (const word of words) {
    const previous = current.at(-1);
    const text = [...current, word].map((entry) => entry.text).join(" ");
    const shouldBreak = current.length && (
      word.start - previous.end >= PAUSE_SECONDS ||
      current.length >= MAX_WORDS ||
      text.length > MAX_CHARACTERS ||
      word.end - current[0].start > MAX_DURATION
    );
    if (shouldBreak) { cues.push(current); current = []; }
    current.push(word);
    if (sentenceEnd(word)) { cues.push(current); current = []; }
  }
  if (current.length) cues.push(current);
  return cues.map((cue) => ({
    sourceId: transcript.sourceId,
    text: cue.map((word) => word.text).join(" "),
    start: cue[0].start,
    end: cue.at(-1).end
  }));
}

function sourcePieces(plan, sourceCatalog) {
  const sequence = plan.operations.find((operation) => operation.type === "sequence");
  const clips = sequence?.clips || (plan.operations.some((operation) => operation.type === "merge")
    ? sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration }))
    : sourceCatalog.slice(0, 1).map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration })));
  let outputStart = 0;
  return clips.map((clip) => {
    const result = { ...clip, outputStart, outputEnd: outputStart + clip.end - clip.start };
    outputStart = result.outputEnd;
    return result;
  });
}

function outputTimeMapper(plan) {
  const trim = plan.operations.find((operation) => operation.type === "trim");
  const speed = plan.operations.find((operation) => operation.type === "speed");
  const trimStart = trim?.start ?? 0;
  const trimEnd = trim?.end ?? Infinity;
  if (!speed) return { trimStart, trimEnd, map: (time) => time - trimStart, breaks: [trimStart, trimEnd] };
  if (speed.start === undefined) return { trimStart, trimEnd, map: (time) => (time - trimStart) / speed.factor, breaks: [trimStart, trimEnd] };
  const speedStart = Math.max(trimStart, speed.start);
  const speedEnd = Math.min(trimEnd, speed.end);
  const map = (time) => {
    if (time <= speedStart) return time - trimStart;
    const before = speedStart - trimStart;
    if (time <= speedEnd) return before + (time - speedStart) / speed.factor;
    return before + (speedEnd - speedStart) / speed.factor + time - speedEnd;
  };
  return { trimStart, trimEnd, map, breaks: [trimStart, speedStart, speedEnd, trimEnd] };
}

/** Maps source-local cues through sequence/merge, trim, and speed into final output time. */
export function mapCaptionCuesToOutput(cues, plan, sourceCatalog) {
  const pieces = sourcePieces(plan, sourceCatalog);
  const temporal = outputTimeMapper(plan);
  const result = [];
  for (const cue of cues) {
    for (const piece of pieces.filter((entry) => entry.sourceId === cue.sourceId)) {
      const sourceStart = Math.max(cue.start, piece.start);
      const sourceEnd = Math.min(cue.end, piece.end);
      if (sourceEnd <= sourceStart) continue;
      const baseStart = piece.outputStart + sourceStart - piece.start;
      const baseEnd = piece.outputStart + sourceEnd - piece.start;
      const visibleStart = Math.max(baseStart, temporal.trimStart);
      const visibleEnd = Math.min(baseEnd, temporal.trimEnd);
      if (visibleEnd <= visibleStart) continue;
      const points = [visibleStart, ...temporal.breaks.filter((point) => point > visibleStart && point < visibleEnd), visibleEnd];
      for (let index = 1; index < points.length; index += 1) {
        const start = temporal.map(points[index - 1]);
        const end = temporal.map(points[index]);
        if (end > start) result.push({ text: cue.text, start, end });
      }
    }
  }
  return result.sort((left, right) => left.start - right.start || left.end - right.end);
}

function replaceCueText(text, from, to) {
  const exact = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  if (exact.test(text)) return text.replace(exact, to);
  return normalizePhrase(text) === normalizePhrase(from) ? to : null;
}

/** Applies a server-validated correction without changing cue timing. */
export function applyCaptionCorrection(cues, correction) {
  const matches = cues.map((cue, index) => ({ index, text: replaceCueText(cue.text, correction.from, correction.to) }))
    .filter((entry) => entry.text !== null)
    .filter((entry) => correction.scope === "all" || correction.at === undefined || (cues[entry.index].start <= correction.at && correction.at <= cues[entry.index].end));
  if (!matches.length || correction.scope !== "all" && matches.length !== 1) {
    throw new CaptionError(matches.length ? "CAPTION_CORRECTION_AMBIGUOUS" : "CAPTION_CORRECTION_NO_MATCH");
  }
  const selected = new Set(matches.map((entry) => entry.index));
  const replacements = new Map(matches.map((entry) => [entry.index, entry.text]));
  return cues.map((cue, index) => selected.has(index) ? { ...cue, text: replacements.get(index) } : cue);
}

export function extractCaptionCorrection(prompt = "") {
  const quoted = String.raw`(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)`;
  const value = (matches, offset) => matches.slice(offset, offset + 4).find((entry) => entry !== undefined);

  const everywhere = prompt.match(new RegExp(`\\bchange\\s+${quoted}\\s+everywhere\\s+to\\s+${quoted}`, "i"));
  if (everywhere) return { from: value(everywhere, 1), to: value(everywhere, 5), scope: "all" };

  const unquotedEverywhere = prompt.match(/\bchange\s+(.+?)\s+everywhere\s+to\s+(.+?)(?:\s+in\s+the\s+video)?[.!?]*\s*$/i);
  if (unquotedEverywhere) {
    return {
      from: unquotedEverywhere[1].trim(),
      to: unquotedEverywhere[2].trim(),
      scope: "all"
    };
  }

  const targeted = prompt.match(new RegExp(`\\bchange\\s+(?:the\\s+)?(?:subtitle\\s+or\\s+sentence|subtitle|sentence)\\s+${quoted}\\s+to\\s+${quoted}\\s+at\\s+(\\d+):(\\d+)`, "i"));
  return targeted
    ? { from: value(targeted, 1), to: value(targeted, 5), scope: "one", at: Number(targeted[9]) * 60 + Number(targeted[10]) }
    : null;
}

export function requestsCaptions(prompt = "") {
  return /\b(?:add|show|make)\s+(?:auto(?:matic)?\s+)?(?:subtitles|captions)\b/i.test(prompt)
    || extractCaptionCorrection(prompt) !== null;
}

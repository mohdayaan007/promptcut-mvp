/** Pure, server-owned transcript helpers. Stage 1 intentionally has no I/O. */
export class TranscriptValidationError extends Error {}

const MAX_SEGMENT_WORDS = 24;
const MAX_SEGMENT_DURATION = 12;
const PAUSE_SECONDS = 0.8;

function fail(message) { throw new TranscriptValidationError(message); }
function validText(text) { return typeof text === "string" && text.trim().length > 0; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }

export function validateTranscriptWords({ sourceId, duration, words }) {
  if (!validText(sourceId)) fail("Transcript sourceId is required");
  if (!finite(duration) || duration <= 0) fail("Transcript source duration is invalid");
  if (!Array.isArray(words)) fail("Transcript words must be an array");
  let previousEnd = 0;
  return words.map((word, index) => {
    if (!validText(word?.text)) fail(`Transcript word ${index + 1} has no usable text`);
    if (!finite(word.start) || !finite(word.end)) fail(`Transcript word ${index + 1} has invalid timestamps`);
    if (word.start < 0 || word.end < word.start || word.end > duration) fail(`Transcript word ${index + 1} has out-of-range timestamps`);
    if (index && word.start < previousEnd) fail(`Transcript word ${index + 1} is not monotonic`);
    previousEnd = word.end;
    return { text: word.text.trim(), start: word.start, end: word.end };
  });
}

function sentenceEnd(word) { return /[.!?](?:[\]\"')}]*)$/.test(word.text); }

/** Segments at sentence ends, meaningful pauses, or conservative word/duration caps. */
export function createCanonicalTranscript({ sourceId, duration, words }) {
  const normalized = validateTranscriptWords({ sourceId, duration, words });
  const segments = [];
  let current = [];
  for (const word of normalized) {
    const previous = current.at(-1);
    const paused = previous && word.start - previous.end >= PAUSE_SECONDS;
    const tooLong = previous && (current.length >= MAX_SEGMENT_WORDS || word.end - current[0].start > MAX_SEGMENT_DURATION);
    if (current.length && (paused || tooLong)) {
      segments.push(current);
      current = [];
    }
    current.push(word);
    if (sentenceEnd(word)) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return {
    sourceId,
    segments: segments.map((segment, index) => ({
      segmentId: `${sourceId}-seg-${index + 1}`,
      start: segment[0].start,
      end: segment.at(-1).end,
      text: segment.map((word) => word.text).join(" "),
      words: segment
    }))
  };
}

const CONTRACTIONS = { "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "can't": "cannot", "don't": "do not", "won't": "will not", "it's": "it is" };
const NUMBER_WORDS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20" };

export function normalizePhrase(value = "") {
  let text = String(value).normalize("NFKC").toLocaleLowerCase().replace(/[’']/g, "'");
  for (const [from, to] of Object.entries(CONTRACTIONS)) text = text.replaceAll(from, to);
  text = text.replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars").replace(/[^\p{L}\p{N}\s]/gu, " ");
  // A narrowly documented STT split observed in Cliponaut's compatibility spike.
  text = text.replace(/\bclip\s+or\s+not\b/g, "cliponaut");
  return text.trim().split(/\s+/).filter(Boolean).map((token) => NUMBER_WORDS[token] || token).join(" ");
}

function levenshtein(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[right.length];
}

function strongNearMatch(phrase, window) {
  const compactPhrase = phrase.replace(/\s/g, "");
  const compactWindow = window.replace(/\s/g, "").replaceAll("clipornot", "cliponaut");
  if (compactPhrase === compactWindow) return true;
  // One edit per five characters, capped at two, allows Cliponaut/Clip or Not without broad matching.
  const allowed = Math.min(2, Math.floor(compactPhrase.length / 5));
  return compactPhrase.length >= 6 && Math.abs(compactPhrase.length - compactWindow.length) <= allowed && levenshtein(compactPhrase, compactWindow) <= allowed;
}

/** Returns every strong contiguous occurrence; callers retain ambiguity rather than selecting a winner. */
export function findPhraseOccurrences(transcript, phrase, mode = "EVENT_SEGMENT") {
  const target = normalizePhrase(phrase);
  if (!target) return [];
  const words = transcript?.segments?.flatMap((segment) => segment.words) || [];
  const tokens = words.map((word) => normalizePhrase(word.text)).filter(Boolean);
  const targetCount = target.split(" ").length;
  const matches = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let size = Math.max(1, targetCount - 1); size <= targetCount + 2 && start + size <= tokens.length; size += 1) {
      const window = tokens.slice(start, start + size).join(" ");
      if (!strongNearMatch(target, window)) continue;
      const first = words[start]; const last = words[start + size - 1];
      matches.push({ start: first.start, end: last.end, mode, wordStartIndex: start, wordEndIndex: start + size - 1 });
    }
  }
  return matches.filter((match, index, all) => index === all.findIndex((other) => other.wordStartIndex === match.wordStartIndex && other.wordEndIndex === match.wordEndIndex));
}

export function pairPhraseOccurrences(starts = [], ends = []) {
  return starts.flatMap((start) => ends
    .filter((end) => end.wordStartIndex > start.wordEndIndex && end.end > start.start)
    .map((end) => ({ start: start.start, end: end.end, startOccurrence: start, endOccurrence: end })));
}

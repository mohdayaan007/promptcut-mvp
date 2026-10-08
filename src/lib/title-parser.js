import { TITLE_DEFAULTS, resolveFontId, resolveSemanticFontIntent } from "@/lib/title-config";

const STYLE_VALUES = {
  position: ["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right", "top", "bottom"],
  size: ["small", "medium", "large"],
  color: ["white", "black", "yellow", "red", "blue", "green", "orange", "purple", "pink"]
};

function findStyleValue(prompt, values, fallback) {
  return values.find((value) => new RegExp(`\\b${value}\\b`, "i").test(prompt)) || fallback;
}

function extractTitleText(prompt) {
  const colonMatch = prompt.match(/\b(?:title|text|caption|headline)\s*:\s*(.+)/i);
  const sayingMatch = prompt.match(/\b(?:title|text|caption|headline)\s+saying\s+(.+)/i);
  const positionedMatch = prompt.match(
    /\b(?:put|show)\s+(.+?)\s+at\s+(?:the\s+)?(?:top|center|bottom)\b/i
  );
  const titleMatch = prompt.match(/\b(?:title|text|caption|headline)\s+(.+)/i);

  let text =
    colonMatch?.[1] ||
    sayingMatch?.[1] ||
    positionedMatch?.[1] ||
    titleMatch?.[1];

  if (!text) return null;

  return text
    .replace(/\s+at\s+\d+:\d+\b.*$/i, "")
    .replace(/\s+at\s+(?:the\s+)?(?:left|right)\s+(?:top|center|bottom)\b.*$/i, "")
    .replace(/\s+at\s+(?:the\s+)?(?:top|center|bottom)\s+(?:left|right)\b.*$/i, "")
    .replace(/\s+at\s+(?:the\s+)?(?:left|right)\b.*$/i, "")
    .replace(/\s+at\s+(?:the\s+)?(?:top|center|bottom)\b.*$/i, "")
    .replace(/\s+(?:using|use)\s+(?:instrument\s+serif|jetbrains\s+mono|inter)\b.*$/i, "")
    .trim();
}

function extractStartTime(prompt) {
  const match = prompt.match(/\bat\s+(\d+):(\d+)\b/i);
  return match ? parseInt(match[1]) * 60 + parseInt(match[2]) : 0;
}

function extractFont(prompt) {
  for (const candidate of ["Instrument Serif", "JetBrains Mono", "Inter"]) {
    if (new RegExp(`\\b${candidate.replace(" ", "\\s+")}\\b`, "i").test(prompt)) return { font: resolveFontId(candidate) };
  }
  const semantic = prompt.match(/\b(clean|minimal|elegant|classy|luxury|editorial|gaming|futuristic|technical|fun|playful|retro|vintage|cinematic)\b(?:[-\s]style)?\s+(?:font|typeface)\b/i)
    || prompt.match(/\b(?:font|typeface)\b.*\b(clean|minimal|elegant|classy|luxury|editorial|gaming|futuristic|technical|fun|playful|retro|vintage|cinematic)\b/i);
  const fontIntent = semantic?.[1]?.toLowerCase();
  if (fontIntent) return { font: resolveSemanticFontIntent(fontIntent), fontIntent };
  // The deterministic fallback must not quietly substitute a made-up exact font
  // request with a local asset. The validator turns this marker into a safe rejection.
  const exactRequest = prompt.match(/\b(?:use|using|in)\s+(?:the\s+)?([a-z][a-z\s-]{1,40}?)\s+(?:font|typeface)\b/i);
  if (exactRequest && /^(?:a\s+)?(?:small|medium|large|bold|regular)$/i.test(exactRequest[1].trim())) {
    return { font: TITLE_DEFAULTS.font };
  }
  return exactRequest ? { font: "__unavailable__" } : { font: TITLE_DEFAULTS.font };
}

export function parseTitle(prompt = "") {
  const text = extractTitleText(prompt);
  if (!text) return null;

  const start = extractStartTime(prompt);

  const font = extractFont(prompt);
  const explicitSize = prompt.match(/\b(\d{1,3})\s*px\b/i);
  const hex = prompt.match(/#[0-9a-f]{6}\b/i);
  return {
    text,
    start,
    end: start + 3,
    position: findStyleValue(prompt, STYLE_VALUES.position, TITLE_DEFAULTS.position),
    size: explicitSize ? Number(explicitSize[1]) : findStyleValue(prompt, STYLE_VALUES.size, TITLE_DEFAULTS.size),
    color: hex?.[0] || findStyleValue(prompt, STYLE_VALUES.color, TITLE_DEFAULTS.color),
    weight: /\bbold\b/i.test(prompt) ? "bold" : TITLE_DEFAULTS.weight,
    ...font
  };
}

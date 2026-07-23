import { TITLE_DEFAULTS } from "@/lib/title-config";

const STYLE_VALUES = {
  position: ["top", "center", "bottom"],
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
  if (/\binstrument\s+serif\b/i.test(prompt)) return "instrumentSerif";
  if (/\bjetbrains\s+mono\b/i.test(prompt)) return "jetbrainsMono";
  return "inter";
}

export function parseTitle(prompt = "") {
  const text = extractTitleText(prompt);
  if (!text) return null;

  const start = extractStartTime(prompt);

  return {
    text,
    start,
    end: start + 3,
    position: findStyleValue(prompt, STYLE_VALUES.position, TITLE_DEFAULTS.position),
    size: findStyleValue(prompt, STYLE_VALUES.size, TITLE_DEFAULTS.size),
    color: findStyleValue(prompt, STYLE_VALUES.color, TITLE_DEFAULTS.color),
    weight: /\bbold\b/i.test(prompt) ? "bold" : TITLE_DEFAULTS.weight,
    font: extractFont(prompt)
  };
}

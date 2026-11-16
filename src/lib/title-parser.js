import { TITLE_DEFAULTS } from "@/lib/title-config";
import { namedTypographyFont, recommendTypographyFonts } from "@/lib/typography/font-recommendations";

const STYLE_VALUES = {
  position: ["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right", "top", "bottom"],
  size: ["small", "medium", "large"],
  color: ["white", "black", "yellow", "red", "blue", "green", "orange", "purple", "pink"]
};

function findStyleValue(prompt, values, fallback) {
  return values.find((value) => new RegExp(`\\b${value}\\b`, "i").test(prompt)) || fallback;
}

function extractTitleText(prompt, { stripQuotedText = false } = {}) {
  // Prefer an explicitly quoted title so punctuation in the requested wording
  // is preserved and the quotation marks themselves never reach the renderer.
  // Legacy title parsing retains quote characters unless a reference-matching
  // caller explicitly requests this safer literal-title form.
  const quotedTitleMatch = stripQuotedText
    ? prompt.match(/\b(?:add|show|put)\s+(?:the\s+)?title\s+(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’)/i)
    : null;
  const colonMatch = prompt.match(/\b(?:title|text|caption|headline)\s*:\s*(.+)/i);
  const sayingMatch = prompt.match(/\b(?:title|text|caption|headline)\s+saying\s+(.+)/i);
  const positionedMatch = prompt.match(
    /\b(?:put|show)\s+(.+?)\s+at\s+(?:the\s+)?(?:top|center|bottom)\b/i
  );
  const titleMatch = prompt.match(/\b(?:title|text|caption|headline)\s+(.+)/i);

  let text =
    quotedTitleMatch?.slice(1).find((value) => value !== undefined) ||
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
  return function extractFont(prompt) {
  const exact = namedTypographyFont(prompt);
  if (exact) return { font: exact };

  // Explicit unavailable font requests remain errors. Never replace a named
  // font with an unrelated one without telling the customer.
  const unknownExact = prompt.match(/\b(?:using|use|in)\s+(?:the\s+)?([a-z][a-z\s-]{1,40}?)\s+(?:font|typeface)\b/i);
  const genericModifiers = /^(?:(?:a|an|the)\s+)?(?:(?:very|slightly|really|super)\s+)?(?:small|medium|large|bold|regular|italic|modern|minimal|clean|elegant|luxury|cinematic|retro|vintage|sporty|futuristic|technical|condensed|serif|sans-serif|handwritten|playful|premium|powerful)(?:[\s-]+(?:small|medium|large|bold|regular|italic|modern|minimal|clean|elegant|luxury|cinematic|retro|vintage|sporty|futuristic|technical|condensed|serif|sans-serif|handwritten|playful|premium|powerful))*$/i;
  if (unknownExact && !genericModifiers.test(unknownExact[1].trim())) return { font: "__unavailable__" };

  // Only infer font character when the prompt actually talks about text
  // styling, not when words such as "cinematic" appear in video colour requests.
  const fontContext = /\b(?:font|typeface|typography|lettering|title|headline|text)\b/i.test(prompt);
  const descriptions = /\b(?:cinematic|luxury|luxurious|elegant|modern|minimal|minimalist|sporty|condensed|retro|vintage|futuristic|technical|hacker|gaming|handwritten|premium|editorial|powerful|bold|playful|clean|sophisticated)\b/i.test(prompt);
  if (fontContext && descriptions) {
    const choices = recommendTypographyFonts(prompt);
    if (choices.length) return { font: choices[0].fontId, fontIntent: choices[0].matched.join(" ") };
  }
  return { font: TITLE_DEFAULTS.font };
}
font: "__unavailable__" } : { font: TITLE_DEFAULTS.font };
}

export function parseTitle(prompt = "", options = {}) {
  const text = extractTitleText(prompt, options);
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

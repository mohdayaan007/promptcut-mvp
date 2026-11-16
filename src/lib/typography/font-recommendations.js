import { FONT_CATALOG, resolveFontId } from "@/lib/title-config";

// Pure, server-owned recommendation logic. Never invent a font or download one
// during a render; only suggest files already installed in the renderer.
const INTENT_ALIASES = Object.freeze({
  premium: ["luxury", "elegant", "editorial"],
  luxurious: ["luxury", "elegant"],
  sophisticated: ["elegant", "editorial"],
  classy: ["classy", "elegant"],
  film: ["cinematic"],
  movie: ["cinematic"],
  cinematic: ["cinematic"],
  sporty: ["bold", "condensed"],
  athletic: ["bold", "condensed"],
  powerful: ["bold", "display"],
  impactful: ["bold", "display"],
  condensed: ["condensed"],
  narrow: ["condensed"],
  modern: ["clean", "minimal"],
  minimalist: ["minimal"],
  simple: ["minimal"],
  corporate: ["clean", "sans-serif"],
  technology: ["technical"],
  tech: ["technical"],
  futuristic: ["futuristic"],
  hacker: ["technical", "mono"],
  terminal: ["technical", "mono"],
  coding: ["mono"],
  retro: ["retro", "vintage"],
  vintage: ["vintage"],
  playful: ["playful"],
  gaming: ["gaming"],
  handwritten: ["handwritten"],
  cursive: ["handwritten"]
});

function tokens(text) {
  return String(text || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
}

/** Deterministic suggestions restricted to physically bundled font files. */
export function recommendTypographyFonts(description, { limit = 4 } = {}) {
  const words = tokens(description);
  const intents = new Set(words);
  for (const word of words) for (const tag of INTENT_ALIASES[word] || []) intents.add(tag);
  const safeLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 12)) : 4;
  return Object.values(FONT_CATALOG)
    .map((font) => {
      const matched = font.tags.filter((tag) => {
        const parts = tag.split(/[^a-z0-9]+/).filter(Boolean);
        return parts.every((part) => intents.has(part));
      });
      return { fontId: font.id, family: font.family, matched, score: matched.length };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family))
    .slice(0, safeLimit);
}

/** Return an installed exact family if named, even when no "font" word appears. */
export function namedTypographyFont(description) {
  const value = String(description || "");
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const found = Object.values(FONT_CATALOG).find((font) =>
    [font.family, ...font.aliases].some((alias) => {
      const label = alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return label && new RegExp(`(?:^|\\s)${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:$|\\s)`).test(normalized);
    })
  );
  return found ? resolveFontId(found.family) : null;
}

import snapshot from "@/lib/typography/google-fonts-snapshot.json";
import { FONT_CATALOG, resolveFontId } from "@/lib/title-config";

// A source-controlled discovery index, NOT a promise that the worker already
// contains all of these font binaries. Never export with a guessed family.
const BUILT_IN = new Set(Object.values(FONT_CATALOG).map((entry) => entry.family.toLowerCase()));
const familyRecords = Object.freeze(snapshot.families.map(([family, slug, license]) =>
  Object.freeze({ family, slug, license, exportReady: BUILT_IN.has(family.toLowerCase()) || Boolean(resolveFontId(family)) })
));
const byFamily = new Map(familyRecords.map((entry) => [entry.family.toLowerCase(), entry]));

function clean(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function googleFontCatalogSize() {
  return familyRecords.length;
}

export function findGoogleFontByFamily(family) {
  if (typeof family !== "string" || family.length > 100) return null;
  return byFamily.get(family.trim().toLowerCase()) || null;
}

export function searchGoogleFonts({ query = "", limit = 30, offset = 0 } = {}) {
  const normalized = clean(query);
  const take = Number.isInteger(limit) ? Math.max(0, Math.min(60, limit)) : 30;
  const skip = Number.isInteger(offset) ? Math.max(0, offset) : 0;
  if (normalized.length > 80) return { total: 0, families: [] };
  const terms = normalized.split(" ").filter(Boolean);
  const found = terms.length
    ? familyRecords.filter((font) => terms.every((term) => clean(font.family).includes(term)))
    : familyRecords;
  return { total: found.length, families: found.slice(skip, skip + take) };
}

/** Trusted Google Fonts stylesheet only, using a family from our snapshot. */
export function googleFontPreviewStylesheet(family) {
  const found = findGoogleFontByFamily(family);
  if (!found) return null;
  const encoded = found.family.replace(/ /g, "+").replace(/[^a-zA-Z0-9+]/g, (character) => encodeURIComponent(character));
  return `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;
}

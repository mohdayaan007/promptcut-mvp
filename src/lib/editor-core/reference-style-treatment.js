import { createCanonicalVisualRecipe } from "@/lib/editor-core/style-profiles";

// This is intentionally separate from named B1 profiles. A later B2A
// reference-analysis step may create only this bounded, server-owned object;
// it cannot supply a profile id, raw FFmpeg, a LUT path, or arbitrary fields.
// Version 2 adds B2-only tonal-band temperature controls. B1 profiles still
// compile exclusively through CanonicalVisualRecipe and never receive them.
export const REFERENCE_STYLE_TREATMENT_VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, REFERENCE_STYLE_TREATMENT_VERSION]);
const TONAL_TEMPERATURE_FIELDS = Object.freeze(["shadowTemperature", "midtoneTemperature", "highlightTemperature"]);

function treatmentError(message) {
  return new Error(`Invalid reference style treatment: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Canonical B2A custom-treatment contract. The treatment is deliberately
 * independent of B1 named profiles and contains only renderer-mappable,
 * normalized primitives. Future reference analysis must produce this shape
 * through server validation rather than passing model-owned filter syntax.
 */
export function createCanonicalReferenceStyleTreatment(input = {}) {
  if (!isPlainObject(input)) throw treatmentError("treatment must be a plain object");
  const allowedFields = new Set(["version", "recipe"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw treatmentError(`unsupported treatment field: ${field}`);
  }

  const version = input.version ?? REFERENCE_STYLE_TREATMENT_VERSION;
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw treatmentError(`unsupported version: ${version}`);
  }
  if (input.recipe !== undefined && !isPlainObject(input.recipe)) {
    throw treatmentError("recipe must be a plain object");
  }

  const rawRecipe = input.recipe || {};
  const baseFields = new Set(Object.keys(createCanonicalVisualRecipe()));
  const extraFields = TONAL_TEMPERATURE_FIELDS.filter((field) => Object.hasOwn(rawRecipe, field));
  for (const field of Object.keys(rawRecipe)) {
    if (!baseFields.has(field) && !TONAL_TEMPERATURE_FIELDS.includes(field)) {
      throw treatmentError(`unsupported recipe field: ${field}`);
    }
  }
  if (version === 1 && extraFields.length) {
    throw treatmentError("version 1 does not support tonal-band temperatures");
  }
  const recipe = {
    ...createCanonicalVisualRecipe(Object.fromEntries(
      Object.entries(rawRecipe).filter(([field]) => baseFields.has(field))
    )),
    ...(version === 2 ? Object.fromEntries(TONAL_TEMPERATURE_FIELDS.map((field) => {
      const value = rawRecipe[field] ?? 0;
      if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
        throw treatmentError(`${field} must be a finite number between -1 and 1`);
      }
      return [field, Object.is(value, -0) ? 0 : value];
    })) : {})
  };
  return Object.freeze({ version, recipe: Object.freeze(recipe) });
}

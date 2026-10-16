import { createCanonicalVisualRecipe } from "@/lib/editor-core/style-profiles";

// This is intentionally separate from named B1 profiles. A later B2A
// reference-analysis step may create only this bounded, server-owned object;
// it cannot supply a profile id, raw FFmpeg, a LUT path, or arbitrary fields.
export const REFERENCE_STYLE_TREATMENT_VERSION = 1;

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
  if (version !== REFERENCE_STYLE_TREATMENT_VERSION) {
    throw treatmentError(`unsupported version: ${version}`);
  }
  if (input.recipe !== undefined && !isPlainObject(input.recipe)) {
    throw treatmentError("recipe must be a plain object");
  }

  return Object.freeze({
    version,
    recipe: createCanonicalVisualRecipe(input.recipe || {})
  });
}

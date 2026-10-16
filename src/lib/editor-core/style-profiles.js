// Server-owned B1 foundation. These identifiers and recipes are internal;
// prompt interpretation and plan/schema wiring intentionally arrive in later
// steps. A recipe contains only renderer-mappable normalized controls, never
// raw FFmpeg, LUT, path, or free-form model data.

export const CANONICAL_VISUAL_RECIPE_LIMITS = Object.freeze({
  brightness: Object.freeze({ min: -1, max: 1 }),
  contrast: Object.freeze({ min: -1, max: 1 }),
  saturation: Object.freeze({ min: -1, max: 1 }),
  temperature: Object.freeze({ min: -1, max: 1 }),
  tint: Object.freeze({ min: -1, max: 1 }),
  // Internal B1/B2 grading primitives. They are not user prompt controls.
  shadows: Object.freeze({ min: -1, max: 1 }),
  highlights: Object.freeze({ min: -1, max: 1 }),
  vibrance: Object.freeze({ min: -1, max: 1 })
});

export const CANONICAL_VISUAL_RECIPE_FIELDS = Object.freeze(Object.keys(CANONICAL_VISUAL_RECIPE_LIMITS));
// This is the initial B1 canonical surface, not a permanent B2 limitation.
// Future tonal primitives must be server-owned, explicit, bounded,
// renderer-mappable, and validated before joining this recipe.

export const NEUTRAL_VISUAL_RECIPE = Object.freeze(
  Object.fromEntries(CANONICAL_VISUAL_RECIPE_FIELDS.map((field) => [field, 0]))
);

export const STYLE_PROFILE_STRENGTHS = Object.freeze({
  subtle: 0.4,
  standard: 0.7,
  strong: 1
});

export const STYLE_PROFILE_CONSTRAINTS = Object.freeze([
  "avoid_darkening",
  "avoid_oversaturation",
  "conservative_color",
  // This deliberately means conservative global color treatment only. It does
  // not claim skin detection, segmentation, tracking, or selective correction.
  "skin_tone_conservative"
]);

function freezeProfile(recipe) {
  return Object.freeze({ recipe: createCanonicalVisualRecipe(recipe) });
}

// Initial recipes are intentionally conservative starting points. They require
// fixture rendering and founder visual calibration before B1 production sign-off.
export const STYLE_PROFILE_CATALOG = Object.freeze({
  clean_commercial: Object.freeze({ currentVersion: 2, versions: Object.freeze({
    // Preserve v1 for historical reproducibility; v2 is calibrated to remain
    // visibly polished after the standard-strength skin-tone constraint.
    1: freezeProfile({ brightness: 0.04, contrast: 0.2, saturation: 0.05, temperature: 0.02, tint: 0 }),
    2: freezeProfile({ brightness: 0.075, contrast: 0.31, saturation: 0.12, temperature: 0.05, tint: 0 })
  }) }),
  warm_travel: Object.freeze({ currentVersion: 1, versions: Object.freeze({
    1: freezeProfile({ brightness: 0.05, contrast: 0.16, saturation: 0.16, temperature: 0.24, tint: 0.01 })
  }) }),
  cinematic: Object.freeze({ currentVersion: 2, versions: Object.freeze({
    // Preserve v1 for historical reproducibility; v2 protects ordinary scenes
    // from automatic shadow loss while retaining the profile's filmic depth.
    1: freezeProfile({ brightness: -0.04, contrast: 0.3, saturation: -0.08, temperature: 0.05, tint: -0.02 }),
    2: freezeProfile({ brightness: 0, contrast: 0.23, saturation: -0.08, temperature: 0.05, tint: -0.02 })
  }) }),
  soft_nostalgic: Object.freeze({ currentVersion: 3, versions: Object.freeze({
    // Preserve v1 for historical reproducibility; v2 retains the warm, gently
    // faded identity without flattening ordinary shadows and midtones as much.
    1: freezeProfile({ brightness: 0.07, contrast: -0.18, saturation: -0.2, temperature: 0.12, tint: 0.02 }),
    2: freezeProfile({ brightness: 0.04, contrast: -0.13, saturation: -0.18, temperature: 0.12, tint: 0.02 }),
    // v3 keeps the airy, warm memory character while restoring photographic
    // life through gentle tonal opening and selective vibrance instead of a
    // broad faded/desaturated treatment.
    3: freezeProfile({ brightness: 0.055, contrast: -0.035, saturation: -0.055, temperature: 0.1, tint: 0.015, shadows: 0.1, highlights: 0.08, vibrance: 0.12 })
  }) }),
  vibrant_social: Object.freeze({ currentVersion: 2, versions: Object.freeze({
    // Preserve v1 exactly. v2 gets campaign energy from tonal separation and
    // vibrance instead of the high-saturation plus warm-colorbalance pairing.
    1: freezeProfile({ brightness: 0.04, contrast: 0.16, saturation: 0.28, temperature: 0.03, tint: 0 }),
    2: freezeProfile({ brightness: 0.025, contrast: 0.06, saturation: 0.025, temperature: 0, tint: 0, shadows: 0.04, highlights: 0.03, vibrance: 0.18 })
  }) }),
  dark_moody: Object.freeze({ currentVersion: 2, versions: Object.freeze({
    // Preserve v1 for historical reproducibility. v2 builds a low-key world
    // with tonal separation and selective color instead of blanket darkening.
    1: freezeProfile({ brightness: -0.16, contrast: 0.24, saturation: -0.1, temperature: -0.04, tint: -0.03 }),
    2: freezeProfile({ brightness: -0.045, contrast: 0.16, saturation: -0.02, temperature: -0.03, tint: -0.01, shadows: 0.12, highlights: 0.15, vibrance: 0.1 })
  }) }),
  natural_documentary: Object.freeze({ currentVersion: 2, versions: Object.freeze({
    // Preserve v1 for historical reproducibility; v2 remains natural while
    // making a clearly perceptible authenticity-first improvement.
    1: freezeProfile({ brightness: 0.015, contrast: 0.08, saturation: 0.02, temperature: 0.01, tint: 0 }),
    2: freezeProfile({ brightness: 0.045, contrast: 0.22, saturation: 0.075, temperature: 0.015, tint: 0 })
  }) })
});

export const STYLE_PROFILE_IDS = Object.freeze(Object.keys(STYLE_PROFILE_CATALOG));

function profileError(message) {
  return new Error(`Invalid style profile: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * CanonicalVisualRecipe is the shared server-owned input for future B1 profiles
 * and B2 reference-derived treatments. It is strictly numeric and bounded.
 */
export function createCanonicalVisualRecipe(values = {}) {
  if (!isPlainObject(values)) throw profileError("recipe must be an object");
  for (const key of Object.keys(values)) {
    if (!CANONICAL_VISUAL_RECIPE_FIELDS.includes(key)) throw profileError(`unsupported recipe field: ${key}`);
  }
  const recipe = {};
  for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
    const value = values[field] ?? NEUTRAL_VISUAL_RECIPE[field];
    const { min, max } = CANONICAL_VISUAL_RECIPE_LIMITS[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw profileError(`${field} must be a finite number between ${min} and ${max}`);
    }
    // JavaScript preserves -0 through interpolation. Canonical recipes use one
    // exact neutral representation so a zero-strength profile equals baseline.
    recipe[field] = Object.is(value, -0) ? 0 : value;
  }
  return Object.freeze(recipe);
}

export function isStyleProfileId(profileId) {
  return typeof profileId === "string" && Object.hasOwn(STYLE_PROFILE_CATALOG, profileId);
}

export function isStyleProfileStrength(strength) {
  return typeof strength === "string" && Object.hasOwn(STYLE_PROFILE_STRENGTHS, strength);
}

export function isStyleProfileConstraint(constraint) {
  return STYLE_PROFILE_CONSTRAINTS.includes(constraint);
}

export function resolveCurrentStyleProfile(profileId) {
  if (!isStyleProfileId(profileId)) throw profileError(`unknown profile: ${profileId}`);
  return resolveStyleProfile(profileId, STYLE_PROFILE_CATALOG[profileId].currentVersion);
}

export function resolveStyleProfile(profileId, profileVersion) {
  if (!isStyleProfileId(profileId)) throw profileError(`unknown profile: ${profileId}`);
  if (!Number.isInteger(profileVersion) || !STYLE_PROFILE_CATALOG[profileId].versions[profileVersion]) {
    throw profileError(`unknown ${profileId} version: ${profileVersion}`);
  }
  const resolved = STYLE_PROFILE_CATALOG[profileId].versions[profileVersion];
  return Object.freeze({ profileId, profileVersion, recipe: createCanonicalVisualRecipe(resolved.recipe) });
}

/** Interpolates from the well-defined neutral/no-style baseline. */
export function interpolateCanonicalVisualRecipe(recipe, factor) {
  const canonical = createCanonicalVisualRecipe(recipe);
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw profileError("strength factor must be a finite number between 0 and 1");
  }
  return createCanonicalVisualRecipe(Object.fromEntries(
    CANONICAL_VISUAL_RECIPE_FIELDS.map((field) => [field, canonical[field] * factor])
  ));
}

function normalizedConstraints(constraints = []) {
  if (!Array.isArray(constraints)) throw profileError("constraints must be an array");
  for (const constraint of constraints) {
    if (!isStyleProfileConstraint(constraint)) throw profileError(`unsupported constraint: ${constraint}`);
  }
  return STYLE_PROFILE_CONSTRAINTS.filter((constraint) => constraints.includes(constraint));
}

function towardNeutral(value, factor) {
  return value * factor;
}

function applyConstraint(recipe, constraint) {
  const constrained = { ...recipe };
  if (constraint === "avoid_darkening") {
    constrained.brightness = Math.max(0, constrained.brightness);
  } else if (constraint === "avoid_oversaturation") {
    constrained.saturation = Math.min(constrained.saturation, 0.12);
  } else if (constraint === "conservative_color") {
    constrained.saturation = towardNeutral(constrained.saturation, 0.75);
    constrained.temperature = towardNeutral(constrained.temperature, 0.65);
    constrained.tint = towardNeutral(constrained.tint, 0.65);
  } else if (constraint === "skin_tone_conservative") {
    constrained.saturation = towardNeutral(constrained.saturation, 0.65);
    constrained.temperature = towardNeutral(constrained.temperature, 0.45);
    constrained.tint = towardNeutral(constrained.tint, 0.45);
    constrained.contrast = towardNeutral(constrained.contrast, 0.85);
  }
  return createCanonicalVisualRecipe(constrained);
}

/** Compiles only static catalog data through a strict public server contract. */
export function compileStyleProfile(input = {}) {
  if (!isPlainObject(input)) throw profileError("compiler input must be a plain object");
  const allowedFields = new Set(["profileId", "profileVersion", "strength", "constraints"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw profileError(`unsupported compiler field: ${field}`);
  }
  const { profileId, profileVersion, strength = "standard", constraints = [] } = input;
  if (!isStyleProfileStrength(strength)) throw profileError(`unsupported strength: ${strength}`);
  const resolved = profileVersion === undefined
    ? resolveCurrentStyleProfile(profileId)
    : resolveStyleProfile(profileId, profileVersion);
  const normalized = normalizedConstraints(constraints);
  let recipe = interpolateCanonicalVisualRecipe(resolved.recipe, STYLE_PROFILE_STRENGTHS[strength]);
  for (const constraint of normalized) recipe = applyConstraint(recipe, constraint);
  return Object.freeze({
    profileId: resolved.profileId,
    profileVersion: resolved.profileVersion,
    strength,
    constraints: Object.freeze([...normalized]),
    recipe
  });
}

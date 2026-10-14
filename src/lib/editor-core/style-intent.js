import { STYLE_PROFILE_CONSTRAINTS, isStyleProfileConstraint, isStyleProfileId, isStyleProfileStrength } from "@/lib/editor-core/style-profiles";
import { extractVisualAdjustmentIntent } from "@/lib/editor-core/visual-adjustments";

const STYLE_FAMILIES = [
  ["soft_nostalgic", /\b(?:soft|nostalgic|look\s+old|vintage\s+look|faded)\b/i],
  ["cinematic", /\b(?:cinematic|filmic|look\s+like\s+a\s+movie|dramatic)\b/i],
  ["dark_moody", /\b(?:dark\s+and\s+moody|moodier)\b/i],
  ["clean_commercial", /\b(?:premium|look\s+expensive|more\s+professional|look\s+like\s+an?\s+ad|luxury\s+brand(?:\s+video)?)\b/i],
  ["vibrant_social", /\b(?:colourful|colorful|more\s+colourful|more\s+colorful|vibrant|good\s+for\s+instagram|social[ -]media\s+ready|less\s+dull)\b/i],
  ["natural_documentary", /\b(?:make\s+(?:this\s+|it\s+)?natural|look\s+natural|documentary(?:-like)?|documentary\s+feel)\b/i],
  ["warm_travel", /\b(?:warm\s+and\s+inviting|travel\s+reel|warm)\b/i]
];

const LEGACY_NAMED_LOOK = /\b(?:apply|use)\s+(?:the\s+)?(?:cinematic|warm|cool)\s+(?:filter|look)\b/i;
const BLACK_AND_WHITE = /\b(?:black\s*(?:and|&)\s*white|grayscale|monochrome)\b/i;
const DELEGATED_STYLE_JUDGMENT = /\b(?:make\s+(?:(?:this|it|the\s+(?:first|second|third|fourth|fifth)\s+video|video\s*\d+|source[-\s]?\d+|(?:the\s+)?[a-z][a-z\s-]{1,48}\s+(?:video|clip|footage))\s+)?look\s+(?:good|nice|as\s+good\s+as\s+possible)|make\s+(?:(?:this|it)\s+)?better|fix\s+the\s+look|do\s+whatever\s+looks\s+best|choose\s+whatever\s+style\s+suits\s+(?:this\s+)?footage)\b/i;
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const STYLE_STRENGTH_LANGUAGE = {
  subtle: /\b(?:slightly|a\s+little|a\s+bit|subtle|subtly|gentle|gently)\b/i,
  strong: /\b(?:very|strongly|intense|intensely|heavy|heavily)\b/i
};
const CONSTRAINT_PATTERNS = [
  ["avoid_darkening", /\b(?:don'?t\s+make\s+it\s+too\s+dark|not\s+too\s+dark|keep\s+it\s+from\s+getting\s+darker)\b/i],
  ["avoid_oversaturation", /\b(?:don'?t\s+oversaturate(?:\s+it)?|not\s+too\s+saturated|not\s+oversaturated)\b/i],
  ["conservative_color", /\b(?:keep\s+(?:the\s+)?colou?rs\s+natural|don'?t\s+push\s+the\s+colou?rs\s+too\s+much)\b/i],
  ["skin_tone_conservative", /\b(?:keep\s+(?:the\s+)?skin\s+tones?\s+natural|protect\s+natural\s+skin\s+tones?)\b/i]
];

// These expressions deliberately mirror the bounded 3C-A controls. They are
// used only to determine whether a style-only request is fully understood.
const DETERMINISTIC_VISUAL_LANGUAGE = [
  /\b(?:increase|raise|reduce|decrease|lower)\s+(?:the\s+)?(?:brightness|exposure|contrast|saturation)\s+by\s+\d+(?:\.\d+)?\s*%/i,
  /\b(?:slightly|a\s+little)\s+(?:brighter|darker|warmer|cooler)\b/i,
  /\b(?:increase|raise|reduce|decrease|lower)\s+(?:the\s+)?(?:brightness|exposure|contrast|saturation)\s+(?:slightly|a\s+little)\b/i,
  /\b(?:brighter|darker|warmer|cooler)\b/i,
  /\b(?:increase|raise)\s+(?:the\s+)?(?:brightness|exposure|contrast|saturation|warmth)\b/i,
  /\b(?:reduce|decrease|lower)\s+(?:the\s+)?(?:brightness|exposure|contrast|saturation)\b/i,
  /\b(?:more\s+contrast(?:y)?|make\s+(?:it\s+)?more\s+contrasty|less\s+saturated)\b/i,
  /\bcool(?:\s+the\s+(?:footage|video))?\s+down(?:\s+slightly)?\b/i,
  /\b(?:a\s+)?(?:slight(?:ly)?|a\s+little)\s+(?:magenta|green)\s+tint\b/i,
  /\b(?:magenta|green)\s+tint\b/i
];

const DETERMINISTIC_GRAMMAR = /\b(?:a|add|an|and|as|at|be|but|by|could|do|feel|for|give|i|in|is|it|just|like|little|look|make|me|my|of|or|please|should|that|the|then|this|to|turn|video|with|would|you)\b/gi;

function explicitSourceId(text = "") {
  const match = String(text).match(/\b(?:video\s*|source[-\s]?)(\d+)\b|\b(first|second|third|fourth|fifth)\s+video\b/i);
  const ordinal = Number(match?.[1]) || ORDINALS[match?.[2]?.toLowerCase()];
  return ordinal ? `source-${ordinal}` : null;
}

function semanticSourceId(text = "", resolvedSemanticSources = []) {
  const matches = resolvedSemanticSources.filter((source) => source?.description && String(text).toLowerCase().includes(String(source.description).toLowerCase()));
  return matches.length === 1 ? matches[0].sourceId : null;
}

function attachedStrength(text, match) {
  const prefix = text.slice(0, match.index || 0).replace(/[\s,;:]+$/, "");
  for (const [strength, expression] of Object.entries(STYLE_STRENGTH_LANGUAGE)) {
    if (new RegExp(`(?:^|\\s)${expression.source.slice(2, -2)}$`, "i").test(prefix)) return strength;
  }
  return "standard";
}

function strengthForMatch(text, match, profileId) {
  const direct = attachedStrength(text, match);
  if (direct !== "standard" || profileId !== "soft_nostalgic") return direct;

  // “Soft” and “nostalgic” are aliases for one profile. If the selected
  // alias is unmodified but another alias is explicitly softened, preserve
  // that unambiguous strength for the shared profile.
  const softNostalgic = STYLE_FAMILIES.find(([id]) => id === profileId)?.[1];
  const aliasStrengths = [...text.matchAll(new RegExp(softNostalgic.source, `${softNostalgic.flags}g`))]
    .map((alias) => attachedStrength(text, alias))
    .filter((strength) => strength !== "standard");
  return aliasStrengths.length === 1 ? aliasStrengths[0] : "standard";
}

function constraintsForPrompt(text) {
  const constraints = CONSTRAINT_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([constraint]) => constraint);
  return STYLE_PROFILE_CONSTRAINTS.filter((constraint) => constraints.includes(constraint));
}

function removeExpressions(text, expressions) {
  return expressions.reduce((remaining, expression) => remaining.replace(new RegExp(expression.source, `${expression.flags.replace("g", "")}g`), " "), text);
}

function hasKnownSource(sourceId, sourceCatalog) {
  return Boolean(sourceId) && sourceCatalog.some((source) => source.sourceId === sourceId);
}

function consumeKnownStyleResidual(text = "") {
  const sourceExpressions = [
    /\b(?:video\s*|source[-\s]?)\d+\b/i,
    /\b(?:first|second|third|fourth|fifth)\s+video\b/i
  ];
  return removeExpressions(text, [
    ...Object.values(STYLE_STRENGTH_LANGUAGE),
    ...CONSTRAINT_PATTERNS.map(([, pattern]) => pattern),
    ...DETERMINISTIC_VISUAL_LANGUAGE,
    ...sourceExpressions
  ])
    .replace(DETERMINISTIC_GRAMMAR, " ")
    .replace(/[\d\s.,!?'"“”()\-–—:;]/g, "")
    .trim();
}

function hasOnlyDeterministicVisualLanguage(prompt = "") {
  if (!extractVisualAdjustmentIntent(prompt)) return false;
  // A descriptive source is not an aesthetic instruction. Existing semantic
  // source resolution remains responsible for interpreting it after this gate.
  const withoutKnownNonStyleCommands = String(prompt)
    .replace(/\b(?:the\s+)?[a-z][a-z\s-]{1,48}\s+(?:video|clip|footage|shot)\b/gi, " ")
    .replace(/\b(?:reduce|set|make|change|turn)\s+(?:the\s+)?(?:audio\s+)?volume\s+(?:to\s+)?\d+(?:\.\d+)?\s*%\b/gi, " ")
    .replace(/\b(?:make|set)\s+(?:the\s+)?(?:audio|volume)\s+(?:quieter|lower|louder|higher)\b/gi, " ")
    .replace(/\b(?:lower|decrease|reduce|increase|raise)\s+(?:the\s+)?(?:audio\s+)?volume\b/gi, " ")
    .replace(/\bturn\s+(?:the\s+)?(?:audio\s+)?volume\s+(?:up|down)\b/gi, " ")
    .replace(/\b(?:add|include|show)\s+(?:subtitles|captions)\b/gi, " ");
  return !consumeKnownStyleResidual(withoutKnownNonStyleCommands);
}

export function hasInvalidExplicitStyleSource(prompt = "", { sourceCatalog = [], resolvedSemanticSources = [] } = {}) {
  const sourceId = explicitSourceId(requiresDelegatedStyleJudgment(prompt) ? prompt : findStyleProfileClause(prompt));
  return Boolean(sourceId && !hasKnownSource(sourceId, sourceCatalog));
}

/** Returns the final command-like style clause without interpreting renderer controls. */
export function findStyleProfileClause(prompt = "") {
  const text = String(prompt);
  const commands = [...text.matchAll(/\b(?:make|give|turn)\b/gi)];
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const start = commands[index].index;
    const end = commands[index + 1]?.index ?? text.length;
    const candidate = text.slice(start, end).trim();
    if (STYLE_FAMILIES.some(([, expression]) => expression.test(candidate))) return candidate;
  }
  return text;
}

export function requiresDelegatedStyleJudgment(prompt = "") {
  return DELEGATED_STYLE_JUDGMENT.test(String(prompt));
}

/** Broad structural gate only; Gemini performs fuzzy aesthetic interpretation. */
export function mayRequestTextStyleInterpretation(prompt = "") {
  const text = String(prompt);
  // Existing deterministic color/adjustment vocabulary must remain on its
  // established path rather than consuming a text-classifier response.
  if (LEGACY_NAMED_LOOK.test(text) || BLACK_AND_WHITE.test(text) || extractStyleProfileIntent(text) || hasOnlyDeterministicVisualLanguage(text)) return false;
  return requiresDelegatedStyleJudgment(text) || /\b(?:look|feel|vibes?|aesthetic|style)\b/i.test(text) || /\b(?:make|give)\s+(?:this|it|the\s+(?:first|second|third|fourth|fifth)\s+video|video\s*\d+|source[-\s]?\d+|(?:the\s+)?[a-z-]+\s+(?:video|clip|footage))\b/i.test(text);
}

export class StyleIntentValidationError extends Error {}

/** Validates the small text-classifier contract before it can affect a plan. */
export function normalizeTextStyleIntent(response, prompt = "") {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new StyleIntentValidationError("style interpretation must be an object");
  }
  const allowed = new Set(["mode", "profileId", "strength", "styleText", "constraints", "coverage"]);
  for (const field of Object.keys(response)) {
    if (!allowed.has(field)) throw new StyleIntentValidationError(`unsupported style interpretation field: ${field}`);
  }
  for (const field of allowed) {
    if (!Object.hasOwn(response, field)) throw new StyleIntentValidationError(`missing style interpretation field: ${field}`);
  }
  const { mode, profileId, strength, styleText, constraints, coverage } = response;
  if (!["semantic_style", "delegated_taste", "not_style"].includes(mode)) throw new StyleIntentValidationError("unsupported style interpretation mode");
  if (!["style_only", "style_plus_other_edits"].includes(coverage)) throw new StyleIntentValidationError("unsupported style interpretation coverage");
  if (!isStyleProfileStrength(strength)) throw new StyleIntentValidationError("unsupported style interpretation strength");
  if (!Array.isArray(constraints) || new Set(constraints).size !== constraints.length || constraints.some((constraint) => !isStyleProfileConstraint(constraint))) {
    throw new StyleIntentValidationError("unsupported style interpretation constraints");
  }
  if (typeof styleText !== "string") throw new StyleIntentValidationError("style interpretation styleText must be a string");
  if (mode === "semantic_style") {
    if (!isStyleProfileId(profileId)) throw new StyleIntentValidationError("semantic style requires a known profile");
    if (!styleText || !String(prompt).includes(styleText) || /\b(?:video\s*\d+|source[-\s]?\d+)\b/i.test(styleText)) {
      throw new StyleIntentValidationError("semantic style requires a valid styleText");
    }
    return {
      mode,
      coverage,
      profileId,
      styleText,
      ...(strength === "standard" ? {} : { strength }),
      ...(constraints.length ? { constraints: STYLE_PROFILE_CONSTRAINTS.filter((constraint) => constraints.includes(constraint)) } : {})
    };
  }
  if (profileId !== "none" || strength !== "standard" || constraints.length) {
    throw new StyleIntentValidationError(`${mode} must not select a profile`);
  }
  if (mode === "delegated_taste") {
    if (!styleText || !String(prompt).includes(styleText) || /\b(?:video\s*\d+|source[-\s]?\d+)\b/i.test(styleText)) {
      throw new StyleIntentValidationError("delegated taste requires a valid styleText");
    }
    return { mode, coverage, styleText };
  }
  if (styleText !== "") throw new StyleIntentValidationError("not_style must not select a styleText");
  return { mode, coverage };
}

/**
 * Fast-path safety is server-owned: after removing the model-localized style
 * text, every remaining token must be deterministic grammar, source scope,
 * a known style qualifier, or a bounded 3C-A adjustment.
 */
export function isServerSafeTextStyleOnlyRequest(prompt = "", intent, options = {}) {
  if (!['semantic_style', 'delegated_taste'].includes(intent?.mode) || intent.coverage !== "style_only") return false;
  const text = String(prompt);
  if (hasInvalidExplicitStyleSource(text, options)) return false;
  const index = text.indexOf(intent.styleText);
  if (index < 0) return false;
  const residual = `${text.slice(0, index)} ${text.slice(index + intent.styleText.length)}`;
  return !consumeKnownStyleResidual(residual);
}

export class DelegatedStyleDecisionValidationError extends Error {}

/** Validates the small content-aware taste decision before it affects a plan. */
export function normalizeDelegatedStyleDecision(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new DelegatedStyleDecisionValidationError("delegated style decision must be an object");
  }
  const allowed = new Set(["decision", "profileId", "strength", "constraints"]);
  for (const field of Object.keys(response)) {
    if (!allowed.has(field)) throw new DelegatedStyleDecisionValidationError(`unsupported delegated style field: ${field}`);
  }
  for (const field of allowed) {
    if (!Object.hasOwn(response, field)) throw new DelegatedStyleDecisionValidationError(`missing delegated style field: ${field}`);
  }
  const { decision, profileId, strength, constraints } = response;
  if (!["selected_style", "no_safe_choice"].includes(decision)) throw new DelegatedStyleDecisionValidationError("unsupported delegated style decision");
  if (!isStyleProfileStrength(strength)) throw new DelegatedStyleDecisionValidationError("unsupported delegated style strength");
  if (!Array.isArray(constraints) || new Set(constraints).size !== constraints.length || constraints.some((constraint) => !isStyleProfileConstraint(constraint))) {
    throw new DelegatedStyleDecisionValidationError("unsupported delegated style constraints");
  }
  if (decision === "no_safe_choice") {
    if (profileId !== "none" || strength !== "standard" || constraints.length) {
      throw new DelegatedStyleDecisionValidationError("no_safe_choice must not select a profile");
    }
    return { decision };
  }
  if (!isStyleProfileId(profileId)) throw new DelegatedStyleDecisionValidationError("selected_style requires a known profile");
  return {
    decision,
    profileId,
    ...(strength === "standard" ? {} : { strength }),
    ...(constraints.length ? { constraints: STYLE_PROFILE_CONSTRAINTS.filter((constraint) => constraints.includes(constraint)) } : {})
  };
}

/** Scope always comes from authoritative prompt parsing/source resolution. */
export function resolveStyleSourceScope(prompt = "", { resolvedSemanticSources = [] } = {}) {
  const clause = findStyleProfileClause(prompt);
  return explicitSourceId(clause) || semanticSourceId(clause, resolvedSemanticSources);
}

/** Extracts only server-owned semantic style identifiers; never renderer values. */
export function extractStyleProfileIntent(prompt = "", { sourceCatalog = [], resolvedSemanticSources = [] } = {}) {
  const text = String(prompt);
  if (!text.trim() || LEGACY_NAMED_LOOK.test(text) || BLACK_AND_WHITE.test(text) || requiresDelegatedStyleJudgment(text)) return null;
  const clause = findStyleProfileClause(text);
  const matches = STYLE_FAMILIES
    .map(([profileId, expression]) => ({ profileId, match: clause.match(expression) || text.match(expression) }))
    .filter(({ match }) => Boolean(match));
  if (!matches.length) return null;

  const selected = matches[0];
  const constraints = constraintsForPrompt(text);
  const sourceId = resolveStyleSourceScope(clause, { resolvedSemanticSources });
  return {
    profileId: selected.profileId,
    ...(strengthForMatch(clause, selected.match, selected.profileId) === "standard" ? {} : { strength: strengthForMatch(clause, selected.match, selected.profileId) }),
    ...(constraints.length ? { constraints } : {}),
    ...(sourceId ? { sourceId } : {})
  };
}

/** Inserts a server-resolved profile while preserving scoped legacy grade rules. */
export function reconcileResolvedStyleProfile(plan, intent) {
  if (!intent) return plan;
  const sameScope = (operation) => (operation.sourceId || null) === (intent.sourceId || null);
  const operations = (plan?.operations || []).filter((operation) =>
    operation?.type !== "style_profile" && !(operation?.type === "color_grade" && sameScope(operation))
  );
  return { ...plan, operations: [...operations, { type: "style_profile", ...intent }] };
}

/** Restores deterministic B1 style intent after any general Gemini planning. */
export function reconcileStyleProfile(plan, prompt = "", options = {}) {
  return reconcileResolvedStyleProfile(plan, extractStyleProfileIntent(prompt, options));
}

/** Conservative guard: style-only requests may skip Gemini and media uploads. */
export function isDeterministicallySafeStyleRequest(prompt = "", options = {}) {
  const text = String(prompt);
  const intent = extractStyleProfileIntent(text, options);
  if (!intent || hasInvalidExplicitStyleSource(text, options)) return false;

  // Consume only language that Step 3A deterministically maps to the style
  // profile, its constraints, source scope, or a bounded visual adjustment.
  // Any remaining meaningful words require the normal Gemini path.
  const profileExpressions = STYLE_FAMILIES.map(([, expression]) => expression);
  const remaining = consumeKnownStyleResidual(removeExpressions(text, [
    ...profileExpressions,
  ]));
  return !remaining;
}

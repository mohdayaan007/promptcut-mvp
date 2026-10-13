export const VISUAL_ADJUSTMENT_LIMITS = { min: -1, max: 1 };

// Positive temperature is warm; negative is cool. Positive tint is magenta;
// negative tint is green. The executor owns the conservative FFmpeg mapping.
const QUALITATIVE = { slight: 0.12, normal: 0.2 };

function explicit(prompt, expression, sign = 1) {
  const match = prompt.match(expression);
  return match ? Number(match[1]) / 100 * sign : null;
}

export function extractVisualAdjustmentIntent(prompt = "") {
  const text = String(prompt);
  const adjustment = {};
  const fields = [["brightness", /\b(?:increase|raise)\s+(?:the\s+)?(?:brightness|exposure)\s+by\s+(\d+(?:\.\d+)?)\s*%/i, /\b(?:reduce|decrease|lower)\s+(?:the\s+)?(?:brightness|exposure)\s+by\s+(\d+(?:\.\d+)?)\s*%/i], ["contrast", /\b(?:increase|raise)\s+(?:the\s+)?contrast\s+by\s+(\d+(?:\.\d+)?)\s*%/i, /\b(?:reduce|decrease|lower)\s+(?:the\s+)?contrast\s+by\s+(\d+(?:\.\d+)?)\s*%/i], ["saturation", /\b(?:increase|raise)\s+(?:the\s+)?saturation\s+by\s+(\d+(?:\.\d+)?)\s*%/i, /\b(?:reduce|decrease|lower)\s+(?:the\s+)?saturation\s+by\s+(\d+(?:\.\d+)?)\s*%/i]];
  for (const [field, up, down] of fields) {
    const positive = explicit(text, up); const negative = explicit(text, down, -1);
    if (positive !== null) adjustment[field] = positive;
    if (negative !== null) adjustment[field] = negative;
  }
  if (/\b(?:slightly|a\s+little)\s+brighter\b|\b(?:increase|raise)\s+(?:the\s+)?(?:brightness|exposure)\s+(?:slightly|a\s+little)\b/i.test(text)) adjustment.brightness ??= QUALITATIVE.slight;
  else if (/\bbrighter\b|\bincrease\s+(?:the\s+)?brightness\b/i.test(text)) adjustment.brightness ??= QUALITATIVE.normal;
  if (/\b(?:slightly|a\s+little)\s+darker\b|\b(?:reduce|decrease|lower)\s+(?:the\s+)?(?:brightness|exposure)\s+(?:slightly|a\s+little)\b/i.test(text)) adjustment.brightness ??= -QUALITATIVE.slight;
  else if (/\bdarker\b/i.test(text)) adjustment.brightness ??= -QUALITATIVE.normal;
  if (/\b(?:increase|raise)\s+(?:the\s+)?contrast\s+(?:slightly|a\s+little)\b/i.test(text)) adjustment.contrast ??= QUALITATIVE.slight;
  else if (/\b(?:increase\s+(?:the\s+)?contrast|more\s+contrast(?:y)?|make\s+(?:it\s+)?more\s+contrasty)\b/i.test(text)) adjustment.contrast ??= QUALITATIVE.normal;
  if (/\b(?:increase|raise)\s+(?:the\s+)?saturation\s+(?:a\s+little|slightly)\b/i.test(text)) adjustment.saturation ??= QUALITATIVE.slight;
  else if (/\b(?:increase|raise)\s+(?:the\s+)?saturation\b/i.test(text)) adjustment.saturation ??= QUALITATIVE.normal;
  if (/\b(?:reduce|decrease|lower)\s+(?:the\s+)?saturation\s+(?:a\s+little|slightly)\b|\bless\s+saturated\b/i.test(text)) adjustment.saturation ??= -QUALITATIVE.slight;
  else if (/\b(?:reduce|decrease|lower)\s+(?:the\s+)?saturation\b/i.test(text)) adjustment.saturation ??= -QUALITATIVE.normal;
  if (/\b(?:slightly|a\s+little)\s+warmer\b/i.test(text)) adjustment.temperature = QUALITATIVE.slight;
  else if (/\bwarmer\b|\bincrease\s+(?:the\s+)?warmth\b/i.test(text)) adjustment.temperature = QUALITATIVE.normal;
  if (/\bcool(?:\s+the\s+(?:footage|video))?\s+down\s+slightly\b|\b(?:slightly|a\s+little)\s+cooler\b/i.test(text)) adjustment.temperature = -QUALITATIVE.slight;
  else if (/\bcool(?:\s+the\s+(?:footage|video))?\s+down\b|\bcooler\b/i.test(text)) adjustment.temperature = -QUALITATIVE.normal;
  if (/\b(?:a\s+)?(?:slight(?:ly)?|a\s+little)\s+magenta\s+tint\b/i.test(text)) adjustment.tint = QUALITATIVE.slight;
  else if (/\bmagenta\s+tint\b/i.test(text)) adjustment.tint = QUALITATIVE.normal;
  if (/\b(?:a\s+)?(?:slight(?:ly)?|a\s+little)\s+green\s+tint\b/i.test(text)) adjustment.tint = -QUALITATIVE.slight;
  else if (/\bgreen\s+tint\b/i.test(text)) adjustment.tint = -QUALITATIVE.normal;
  return Object.keys(adjustment).length ? { type: "visual_adjustment", ...adjustment } : null;
}

export function findVisualAdjustmentClause(prompt = "") {
  const text = String(prompt);
  const visualTerm = /\b(?:brighter|darker|brightness|exposure|contrast|contrasty|saturation|warmer|cooler|warmth|magenta\s+tint|green\s+tint)\b/i;
  const commands = [...text.matchAll(/\b(?:make|increase|reduce|decrease|lower|raise|cool|add)\b/gi)];
  const visualCommands = commands.map((command, index) => visualTerm.test(text.slice(command.index, commands[index + 1]?.index)));
  const lastVisual = visualCommands.lastIndexOf(true);
  if (lastVisual < 0) return "";
  let start = null;
  // Work backward through the last contiguous visual run. Later nonvisual
  // edits (title, captions, audio) remain outside the adjustment clause.
  for (let index = lastVisual; index >= 0; index -= 1) {
    if (!visualCommands[index]) break;
    start = commands[index].index;
  }
  return start === null ? "" : text.slice(start, commands[lastVisual + 1]?.index).trim();
}

function sourceIdForPrompt(prompt, sourceCatalog, resolvedSemanticSources) {
  const text = String(prompt);
  const clause = findVisualAdjustmentClause(text);
  const match = clause.match(/\b(?:video\s*|source[-\s]?)(\d+)\b|\b(first|second|third|fourth|fifth)\s+video\b/i);
  const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  const explicit = match ? `source-${match[1] || ordinals[match[2]?.toLowerCase()]}` : null;
  if (sourceCatalog.some((source) => source.sourceId === explicit)) return explicit;
  // Semantic resolution is authoritative only when its description is part of
  // the adjustment clause; a separate semantic selection must not global-scope.
  const normalizedClause = clause.toLowerCase();
  const semanticMatches = resolvedSemanticSources.filter((source) => source?.description && normalizedClause.includes(String(source.description).toLowerCase()));
  return semanticMatches.length === 1 ? semanticMatches[0].sourceId : null;
}

export function reconcileVisualAdjustments(plan, prompt = "", { sourceCatalog = [], resolvedSemanticSources = [] } = {}) {
  const intent = extractVisualAdjustmentIntent(prompt);
  if (!intent) return plan;
  const sourceId = sourceIdForPrompt(prompt, sourceCatalog, resolvedSemanticSources);
  const retained = (plan?.operations || []).filter((operation) => operation?.type !== "visual_adjustment");
  return { ...plan, operations: [...retained, { ...intent, ...(sourceId ? { sourceId } : {}) }] };
}

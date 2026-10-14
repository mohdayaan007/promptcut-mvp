import { CAPTION_DEFAULTS, FONT_CATALOG, normalizeTitleColor, normalizeTitlePosition, normalizeTitleSize, normalizeTitleWeight, resolveFontId, resolveSemanticFontIntent } from "@/lib/title-config";
import { CAPABILITY_LIMITS, getCapability } from "@/lib/editor-core/capability-registry";
import { compileStyleProfile } from "@/lib/editor-core/style-profiles";

function validationError(message) {
  return new Error(`Invalid edit plan: ${message}`);
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateTitle(operation) {
  if (typeof operation.text !== "string" || !operation.text.trim()) {
    throw validationError("title text must be non-empty");
  }
  if (!isNonNegativeNumber(operation.start) || !isNonNegativeNumber(operation.end) || operation.end <= operation.start) {
    throw validationError("title timestamps must be a valid positive range");
  }
  operation.position = normalizeTitlePosition(operation.position);
  operation.size = normalizeTitleSize(operation.size);
  operation.color = normalizeTitleColor(operation.color);
  operation.weight = normalizeTitleWeight(operation.weight);
  operation.font = operation.fontIntent ? resolveSemanticFontIntent(operation.fontIntent) : resolveFontId(operation.font);
  if (!operation.position || !operation.size || !operation.color) {
    throw validationError("title position, size, or color is unsupported");
  }
  if (!operation.font || !operation.weight || !FONT_CATALOG[operation.font]?.weights.includes(operation.weight)) {
    throw validationError("title font or weight is unsupported");
  }
  const rawRuns = operation.runs === undefined ? [{ text: operation.text }] : operation.runs;
  if (!Array.isArray(rawRuns) || !rawRuns.length || rawRuns.length > 20) {
    throw validationError("title runs must be a non-empty bounded array");
  }
  operation.runs = rawRuns.map((run) => {
    if (!run || typeof run.text !== "string" || !run.text.length) throw validationError("title run text must be non-empty");
    const font = run.fontIntent ? resolveSemanticFontIntent(run.fontIntent) : resolveFontId(run.font ?? operation.font);
    const size = normalizeTitleSize(run.size ?? operation.size);
    const color = normalizeTitleColor(run.color ?? operation.color);
    const weight = normalizeTitleWeight(run.weight ?? operation.weight);
    if (!font || !size || !color || !weight || !FONT_CATALOG[font]?.weights.includes(weight)) {
      throw validationError("title run font, size, color, or weight is unsupported");
    }
    return { text: run.text, font, size, color, weight };
  });
  if (operation.runs.map((run) => run.text).join("") !== operation.text) {
    throw validationError("title runs must reproduce title text exactly");
  }
}

function validateCaptions(operation) {
  operation.position = normalizeTitlePosition(operation.position ?? CAPTION_DEFAULTS.position);
  operation.size = normalizeTitleSize(operation.size ?? CAPTION_DEFAULTS.size);
  operation.color = normalizeTitleColor(operation.color ?? CAPTION_DEFAULTS.color);
  operation.weight = normalizeTitleWeight(operation.weight ?? CAPTION_DEFAULTS.weight);
  operation.font = operation.fontIntent ? resolveSemanticFontIntent(operation.fontIntent) : resolveFontId(operation.font ?? CAPTION_DEFAULTS.font);
  if (!operation.position || !operation.size || !operation.color || !operation.weight || !operation.font || !FONT_CATALOG[operation.font]?.weights.includes(operation.weight)) {
    throw validationError("caption style is unsupported");
  }
}

function validateTimedOperation(operation, name) {
  if (!isNonNegativeNumber(operation.start) || !isNonNegativeNumber(operation.end) || operation.end <= operation.start) {
    throw validationError(`${name} timestamps must be a valid positive range`);
  }
}

function sourceCatalogById(sourceCatalog) {
  return new Map(sourceCatalog.map((source) => [source.sourceId, source]));
}

function validateSequence(operation, sources) {
  if (!Array.isArray(operation.clips) || !operation.clips.length) {
    throw validationError("sequence requires at least one clip");
  }
  if (operation.clips.length > 20) throw validationError("sequence supports at most 20 clips");
  for (const clip of operation.clips) {
    const source = sources.get(clip?.sourceId);
    if (!source) throw validationError(`unknown source: ${clip?.sourceId || "unknown"}`);
    validateTimedOperation(clip, "sequence clip");
    if (clip.end > source.duration + 0.01) {
      throw validationError(`sequence clip exceeds ${clip.sourceId} duration`);
    }
  }
}

function validateStyleProfile(operation) {
  const allowedFields = new Set(["type", "profileId", "strength", "constraints", "sourceId"]);
  for (const field of Object.keys(operation)) {
    if (!allowedFields.has(field)) throw validationError(`style_profile does not support ${field}`);
  }
  if (Array.isArray(operation.constraints) && new Set(operation.constraints).size !== operation.constraints.length) {
    throw validationError("style_profile constraints must not contain duplicates");
  }
  try {
    // profileVersion intentionally remains server-owned: plans select an ID,
    // while the compiler resolves the catalog's current server version.
    compileStyleProfile({
      profileId: operation.profileId,
      ...(operation.strength === undefined ? {} : { strength: operation.strength }),
      ...(operation.constraints === undefined ? {} : { constraints: operation.constraints })
    });
  } catch (error) {
    throw validationError(error.message.replace(/^Invalid style profile: /, "style_profile "));
  }
}

export function validateEditPlan(plan, { sourceCatalog = [] } = {}) {
  if (!plan || !["1", "2"].includes(plan.version) || !Array.isArray(plan.operations)) {
    throw validationError("version 1 or 2 with an operations array is required");
  }

  const sourceAware = plan.version === "2";
  const sources = sourceCatalogById(sourceCatalog);
  if (sourceAware && !sources.size) throw validationError("version 2 requires a source catalog");
  const seenSingletons = new Set();
  const zoomRanges = [];
  const colorGradeScopes = new Set();
  const styleProfileScopes = new Set();
  let sequenceCount = 0;
  for (const operation of plan.operations) {
    const capability = getCapability(operation?.type);
    if (!capability) throw validationError(`unsupported operation type: ${operation?.type || "unknown"}`);

    if (operation.type === "sequence") {
      if (!sourceAware) throw validationError("sequence requires version 2");
      sequenceCount += 1;
      if (sequenceCount > 1) throw validationError("only one sequence operation is allowed");
      validateSequence(operation, sources);
      continue;
    }

    if (operation.sourceId !== undefined) {
      if (!sourceAware || !["color_grade", "style_profile", "visual_adjustment"].includes(operation.type)) {
        throw validationError("sourceId is supported only for version 2 color_grade, style_profile, or visual_adjustment operations");
      }
      if (!sources.has(operation.sourceId)) throw validationError(`unknown source: ${operation.sourceId}`);
    }

    for (const field of capability.requiredFields) {
      if (operation[field] === undefined || operation[field] === null) {
        throw validationError(`${operation.type} requires ${field}`);
      }
    }

    if (["merge", "color_grade", "style_profile", "visual_adjustment", "trim", "speed", "fade", "audio_volume", "audio_fade", "crop", "captions"].includes(operation.type)) {
      if (seenSingletons.has(operation.type)) throw validationError(`only one ${operation.type} operation is allowed`);
      seenSingletons.add(operation.type);
    }

    if (operation.type === "color_grade" && !capability.supportedValues[operation.style]) {
      throw validationError(`unsupported color grade: ${operation.style}`);
    }
    if (operation.type === "color_grade") colorGradeScopes.add(operation.sourceId || "global");
    if (operation.type === "style_profile") {
      validateStyleProfile(operation);
      styleProfileScopes.add(operation.sourceId || "global");
    }
    if (operation.type === "visual_adjustment") {
      const fields = ["brightness", "contrast", "saturation", "temperature", "tint"];
      const present = fields.filter((field) => operation[field] !== undefined);
      if (!present.length) throw validationError("visual_adjustment requires at least one adjustment");
      for (const field of present) {
        const value = operation[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < CAPABILITY_LIMITS.visualAdjustment.min || value > CAPABILITY_LIMITS.visualAdjustment.max) throw validationError(`visual adjustment ${field} must be between -1 and 1`);
      }
    }
    if (operation.type === "trim") validateTimedOperation(operation, "trim");
    if (operation.type === "title") validateTitle(operation);
    if (operation.type === "captions") validateCaptions(operation);
    if (operation.type === "zoom") {
      validateTimedOperation(operation, "zoom");
      if (!isNonNegativeNumber(operation.amount) || operation.amount < CAPABILITY_LIMITS.zoom.minAmount || operation.amount > CAPABILITY_LIMITS.zoom.maxAmount) {
        throw validationError(`zoom amount must be between ${CAPABILITY_LIMITS.zoom.minAmount} and ${CAPABILITY_LIMITS.zoom.maxAmount}`);
      }
      zoomRanges.push({ start: operation.start, end: operation.end });
    }
    if (operation.type === "speed") {
      if (!isNonNegativeNumber(operation.factor) || operation.factor < CAPABILITY_LIMITS.speed.minFactor || operation.factor > CAPABILITY_LIMITS.speed.maxFactor) {
        throw validationError(`speed factor must be between ${CAPABILITY_LIMITS.speed.minFactor} and ${CAPABILITY_LIMITS.speed.maxFactor}`);
      }
      const hasStart = operation.start !== undefined;
      const hasEnd = operation.end !== undefined;
      if (hasStart !== hasEnd) throw validationError("speed requires both start and end, or neither for global speed");
      if (hasStart) validateTimedOperation(operation, "speed");
    }
    if (operation.type === "fade") {
      if (!getCapability("fade").modes.includes(operation.mode)) throw validationError("fade mode is unsupported");
      if (!isNonNegativeNumber(operation.duration) || operation.duration < CAPABILITY_LIMITS.fade.minDuration || operation.duration > CAPABILITY_LIMITS.fade.maxDuration) {
        throw validationError(`fade duration must be between ${CAPABILITY_LIMITS.fade.minDuration} and ${CAPABILITY_LIMITS.fade.maxDuration}`);
      }
    }
    if (operation.type === "audio_volume") {
      if (typeof operation.factor !== "number" || !Number.isFinite(operation.factor) || operation.factor < CAPABILITY_LIMITS.audioVolume.minFactor || operation.factor > CAPABILITY_LIMITS.audioVolume.maxFactor) {
        throw validationError(`audio volume factor must be between ${CAPABILITY_LIMITS.audioVolume.minFactor} and ${CAPABILITY_LIMITS.audioVolume.maxFactor}`);
      }
    }
    if (operation.type === "audio_fade") {
      if (!getCapability("audio_fade").modes.includes(operation.mode)) throw validationError("audio fade mode is unsupported");
      if (!isNonNegativeNumber(operation.duration) || operation.duration < CAPABILITY_LIMITS.fade.minDuration || operation.duration > CAPABILITY_LIMITS.fade.maxDuration) {
        throw validationError(`audio fade duration must be between ${CAPABILITY_LIMITS.fade.minDuration} and ${CAPABILITY_LIMITS.fade.maxDuration}`);
      }
    }
    if (operation.type === "crop" && !CAPABILITY_LIMITS.aspectRatios.includes(operation.aspect_ratio)) {
      throw validationError("crop aspect ratio is unsupported");
    }
  }

  for (const scope of styleProfileScopes) {
    if (colorGradeScopes.has(scope)) {
      throw validationError(`style_profile conflicts with color_grade for ${scope === "global" ? "global" : scope} scope`);
    }
  }

  if (sourceAware) {
    if (seenSingletons.has("merge")) throw validationError("version 2 sequence cannot include merge");
    if (sequenceCount !== 1) throw validationError("version 2 requires exactly one sequence operation");
  }

  zoomRanges.sort((first, second) => first.start - second.start);
  for (let index = 1; index < zoomRanges.length; index += 1) {
    if (zoomRanges[index].start < zoomRanges[index - 1].end) {
      throw validationError("zoom operations must not overlap");
    }
  }

  return plan;
}

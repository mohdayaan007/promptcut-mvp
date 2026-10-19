import { spawn } from "child_process";
import path from "path";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { applyCaptionCorrection, CaptionError, mapCaptionCuesToOutput } from "@/lib/editor-core/caption-engine";
import { buildAssFilter, writeTitleAssFile } from "@/lib/title-renderer";
import { FONT_CATALOG, titleFontSize } from "@/lib/title-config";
import { buildNormalizationFilter, createMediaProfile, getCropSettings } from "@/lib/editor-core/media-profile";
import { compileStyleProfile, createCanonicalVisualRecipe } from "@/lib/editor-core/style-profiles";
import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const FFMPEG_TERMINATION_GRACE_MS = 5_000;
const VIDEO_ENCODING_ARGS = [
  "-threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"
];
const AUDIO_ONLY_ENCODING_ARGS = ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"];

// One server-owned order applies before source sequence assembly and again to
// the assembled global timeline. Do not use prompt or model operation order.
export const VISUAL_OPERATION_ORDER = Object.freeze([
  "color_grade",
  "style_profile",
  "reference_style_treatment",
  "visual_adjustment"
]);

export function orderedVisualOperations(operations, { sourceId, sourceScoped = false } = {}) {
  const matchesScope = sourceId !== undefined
    ? (operation) => operation.sourceId === sourceId
    : sourceScoped
      ? (operation) => Boolean(operation.sourceId)
      : (operation) => !operation.sourceId;
  return VISUAL_OPERATION_ORDER.flatMap((type) => operations.filter(
    (operation) => operation.type === type && matchesScope(operation)
  ));
}

export class EditExecutionCancelledError extends Error {
  constructor() {
    super("Edit execution was cancelled");
    this.name = "EditExecutionCancelledError";
  }
}

/** Tracks only the FFmpeg/FFprobe child currently owned by one edit execution. */
export function createExecutionController({ gracePeriodMs = FFMPEG_TERMINATION_GRACE_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let activeChild = null;
  let gracefulChild = null;
  let forceKillTimer = null;
  let cancelled = false;

  function clearForceKillTimer() {
    if (forceKillTimer) clearTimeoutFn(forceKillTimer);
    forceKillTimer = null;
  }

  function terminate(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null || gracefulChild === child) return false;
    gracefulChild = child;
    child.kill("SIGTERM");
    forceKillTimer = setTimeoutFn(() => {
      if (activeChild === child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, gracePeriodMs);
    return true;
  }

  return {
    isCancelled: () => cancelled,
    throwIfCancelled() {
      if (cancelled) throw new EditExecutionCancelledError();
    },
    attach(child) {
      activeChild = child;
      if (cancelled) terminate(child);
    },
    detach(child) {
      if (activeChild !== child) return;
      activeChild = null;
      if (gracefulChild === child) gracefulChild = null;
      clearForceKillTimer();
    },
    cancel() {
      cancelled = true;
      return terminate(activeChild);
    },
    dispose() {
      clearForceKillTimer();
      activeChild = null;
      gracefulChild = null;
    }
  };
}

function exec(cmd, args, { executionController } = {}) {
  executionController?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      executionController?.detach(child);
      if (error) reject(error);
      else resolve(result);
    };

    executionController?.attach(child);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      finish(executionController?.isCancelled() ? new EditExecutionCancelledError() : error);
    });
    child.once("close", (code, signal) => {
      if (executionController?.isCancelled()) return finish(new EditExecutionCancelledError());
      if (code === 0) return finish(null, { stdout, stderr });
      return finish(new Error(stderr.trim() || `${cmd} exited with ${signal || `code ${code}`}`));
    });
  });
}

async function normalize(input, output, media, profile, executionController) {
  const mappingArgs = media.hasAudio
    ? ["-map", "0:v:0", "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0"]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0", "-shortest"];

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", input,
    ...mappingArgs, "-vf", buildNormalizationFilter(profile, media), ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
}

async function mergeVideos(inputs, output, executionController) {
  const filterInputs = inputs.map((_, index) => `[${index}:v][${index}:a]`).join("");
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", ...inputs.flatMap((input) => ["-i", input]), "-filter_complex",
    `${filterInputs}concat=n=${inputs.length}:v=1:a=1[v][a]`, "-map", "[v]", "-map", "[a]",
    // The concat filter can receive legitimate mixed-CFR clips (for example
    // 24fps followed by 30fps). Preserve their frame timestamps instead of
    // letting FFmpeg synthesize a common-CFR stream with duplicated frames.
    "-fps_mode", "vfr", ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
}

async function applyColorGrade(input, output, style, executionController) {
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-vf", COLOR_PRESETS[style].join(","), ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
}

async function applyReferenceStyleTreatment(input, output, operation, executionController) {
  const treatment = createCanonicalReferenceStyleTreatment(operation.treatment);
  await exec(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", buildReferenceStyleTreatmentFilters(treatment.recipe).join(","), ...VIDEO_ENCODING_ARGS, output], { executionController });
}

// The server preserves the normalized -1..1 contract but curves low and medium
// magnitudes so everyday requests are perceptible without raising any maximum.
// 0 and +/-1 remain exact anchors; the curve is monotonic between them.
export function perceptualAdjustmentMagnitude(value) {
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.min(1, Math.abs(value));
  return Math.sign(value) * (0.35 * magnitude + 0.65 * Math.sqrt(magnitude));
}

const COLORBALANCE_MAX = 0.32;
const TEMPERATURE_MAX = 0.24;
const TINT_MAX = 0.19;
const TEMPERATURE_SHADOW_HIGHLIGHT_WEIGHT = 0.75;
const COMBINED_BRIGHTNESS_HEADROOM = 0.8;
const COMBINED_CONTRAST_HEADROOM = 0.82;
const THREE_WAY_TEMPERATURE_HEADROOM = 0.9;
const TONE_CURVE_SHADOW_ANCHOR = 0.25;
const TONE_CURVE_HIGHLIGHT_ANCHOR = 0.75;
const TONE_CURVE_SHADOW_RANGE = Object.freeze({ min: 0.08, max: 0.42 });
const TONE_CURVE_HIGHLIGHT_MAX = 0.94;
const TONE_CURVE_MINIMUM_SEPARATION = 0.12;
const TONE_CURVE_SHADOW_SCALE = 0.1;
const TONE_CURVE_HIGHLIGHT_SCALE = 0.08;
const VIBRANCE_MAX = 0.5;
const BLACK_LIFT_MAX = 0.055;
const BLACK_DENSITY_SHADOW_MAX = 0.04;
// A narrower gamma span prevents a strong midtone pivot from consuming too
// many adjacent 8-bit code values before the later monotonic tone curve.
const MIDTONE_GAMMA_MAX_OFFSET = 0.18;

function boundedColorBalance(value) {
  return Math.max(-COLORBALANCE_MAX, Math.min(COLORBALANCE_MAX, value));
}

function boundedStylePrimitive(value, name) {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`Invalid style recipe: ${name} must be a finite number between -1 and 1`);
  }
  return value;
}

/** Builds only server-owned, monotonic curve points; no raw curve text enters plans. */
export function buildToneCurvePoints({ shadows, highlights } = {}) {
  const shadowValue = boundedStylePrimitive(shadows, "shadows");
  const highlightValue = boundedStylePrimitive(highlights, "highlights");
  const shadowPoint = Math.max(
    TONE_CURVE_SHADOW_RANGE.min,
    Math.min(TONE_CURVE_SHADOW_RANGE.max, TONE_CURVE_SHADOW_ANCHOR + TONE_CURVE_SHADOW_SCALE * perceptualAdjustmentMagnitude(shadowValue))
  );
  const highlightPoint = Math.max(
    shadowPoint + TONE_CURVE_MINIMUM_SEPARATION,
    Math.min(TONE_CURVE_HIGHLIGHT_MAX, TONE_CURVE_HIGHLIGHT_ANCHOR + TONE_CURVE_HIGHLIGHT_SCALE * perceptualAdjustmentMagnitude(highlightValue))
  );
  return Object.freeze({ shadowPoint, highlightPoint });
}

export function buildToneCurveFilter(recipe = {}) {
  const shadows = boundedStylePrimitive(recipe.shadows, "shadows");
  const highlights = boundedStylePrimitive(recipe.highlights, "highlights");
  if (shadows === 0 && highlights === 0) return null;
  const { shadowPoint, highlightPoint } = buildToneCurvePoints({ shadows, highlights });
  return `curves=master='0/0 0.25/${shadowPoint.toFixed(4)} 0.75/${highlightPoint.toFixed(4)} 1/1'`;
}

export function buildVibranceFilter(recipe = {}) {
  const vibrance = boundedStylePrimitive(recipe.vibrance, "vibrance");
  if (vibrance === 0) return null;
  const intensity = perceptualAdjustmentMagnitude(vibrance) * VIBRANCE_MAX;
  return `vibrance=intensity=${intensity.toFixed(4)}:rbal=1:gbal=1:bbal=1:alternate=0`;
}

function buildEqFilter(operation, { includeMidtoneGamma = false } = {}) {
  const eq = [];
  const brightnessAndPositiveContrast = operation.brightness > 0 && operation.contrast > 0;
  const brightnessHeadroom = brightnessAndPositiveContrast ? COMBINED_BRIGHTNESS_HEADROOM : 1;
  const contrastHeadroom = brightnessAndPositiveContrast ? COMBINED_CONTRAST_HEADROOM : 1;
  if (operation.brightness !== undefined) eq.push(`brightness=${(perceptualAdjustmentMagnitude(operation.brightness) * 0.45 * brightnessHeadroom).toFixed(4)}`);
  if (operation.contrast !== undefined) eq.push(`contrast=${(1 + perceptualAdjustmentMagnitude(operation.contrast) * 0.9 * contrastHeadroom).toFixed(4)}`);
  if (operation.saturation !== undefined) eq.push(`saturation=${(1 + perceptualAdjustmentMagnitude(operation.saturation) * 0.9).toFixed(4)}`);
  if (includeMidtoneGamma) {
    const midtoneGamma = boundedStylePrimitive(operation.midtoneGamma, "midtoneGamma");
    if (midtoneGamma !== 0) {
      const gamma = 1 + (perceptualAdjustmentMagnitude(midtoneGamma) * MIDTONE_GAMMA_MAX_OFFSET);
      eq.push(`gamma=${gamma.toFixed(4)}`);
    }
  }
  return eq.length ? `eq=${eq.join(":")}` : null;
}

function buildColorBalanceFilter(operation, { preserveLightness = true } = {}) {
  if (operation.temperature === undefined && operation.tint === undefined) return null;
  const brightnessAndPositiveContrast = operation.brightness > 0 && operation.contrast > 0;
  const temperatureHeadroom = brightnessAndPositiveContrast && operation.temperature !== undefined
    ? THREE_WAY_TEMPERATURE_HEADROOM
    : 1;
  const temperature = perceptualAdjustmentMagnitude(operation.temperature || 0) * TEMPERATURE_MAX * temperatureHeadroom;
  const tint = perceptualAdjustmentMagnitude(operation.tint || 0) * TINT_MAX;
  // Temperature is strongest through useful midtones and gentler in shadows
  // and highlights. Tint moves the green↔magenta axis rather than adding red.
  const redShadowHighlight = boundedColorBalance(temperature * TEMPERATURE_SHADOW_HIGHLIGHT_WEIGHT);
  const redMidtone = boundedColorBalance(temperature);
  const green = boundedColorBalance(-tint);
  const blueShadowHighlight = boundedColorBalance(-temperature * TEMPERATURE_SHADOW_HIGHLIGHT_WEIGHT);
  const blueMidtone = boundedColorBalance(-temperature);
  return `colorbalance=rs=${redShadowHighlight.toFixed(4)}:gs=${green.toFixed(4)}:bs=${blueShadowHighlight.toFixed(4)}:rm=${redMidtone.toFixed(4)}:gm=${green.toFixed(4)}:bm=${blueMidtone.toFixed(4)}:rh=${redShadowHighlight.toFixed(4)}:gh=${green.toFixed(4)}:bh=${blueShadowHighlight.toFixed(4)}:pl=${preserveLightness ? 1 : 0}`;
}

// B2 alone can express a bounded color relationship by tonal band. This is
// intentionally not part of B1's shared profile compiler: reference matching
// owns these server-derived controls and no model supplies renderer syntax.
function buildReferenceColorBalanceFilter(operation) {
  const hasBandTemperature = ["shadowTemperature", "midtoneTemperature", "highlightTemperature"]
    .some((field) => (operation[field] ?? 0) !== 0);
  // Keep historic B2 v1/v2-global recipes byte-for-byte equivalent. The
  // separate path activates only when the new tonal relationship is present.
  if (!hasBandTemperature) {
    return (operation.temperature ?? 0) !== 0 || (operation.tint ?? 0) !== 0
      ? buildColorBalanceFilter(operation, { preserveLightness: false })
      : null;
  }
  if (!hasBandTemperature && (operation.temperature ?? 0) === 0 && (operation.tint ?? 0) === 0) return null;
  const temperature = perceptualAdjustmentMagnitude(operation.temperature || 0) * TEMPERATURE_MAX;
  const tint = perceptualAdjustmentMagnitude(operation.tint || 0) * TINT_MAX;
  const band = (field, base, maximum) => boundedColorBalance(
    base + (perceptualAdjustmentMagnitude(operation[field] || 0) * maximum)
  );
  const shadow = band("shadowTemperature", temperature * TEMPERATURE_SHADOW_HIGHLIGHT_WEIGHT, 0.16);
  const midtone = band("midtoneTemperature", temperature, 0.18);
  const highlight = band("highlightTemperature", temperature * TEMPERATURE_SHADOW_HIGHLIGHT_WEIGHT, 0.16);
  const green = boundedColorBalance(-tint);
  return `colorbalance=rs=${shadow.toFixed(4)}:gs=${green.toFixed(4)}:bs=${(-shadow).toFixed(4)}:rm=${midtone.toFixed(4)}:gm=${green.toFixed(4)}:bm=${(-midtone).toFixed(4)}:rh=${highlight.toFixed(4)}:gh=${green.toFixed(4)}:bh=${(-highlight).toFixed(4)}:pl=0`;
}

// Converts bounded server-facing controls to perceptible, still bounded FFmpeg
// filters. No duration-changing filters are used here, and normalized values
// never reach FFmpeg directly as user-controlled filter syntax.
export function buildVisualAdjustmentFilters(operation) {
  const filters = [];
  const eq = buildEqFilter(operation);
  const colorbalance = buildColorBalanceFilter(operation);
  if (eq) filters.push(eq);
  if (colorbalance) filters.push(colorbalance);
  return filters;
}

/** Style recipes may use extra server-owned primitives; user adjustments may not. */
export function buildStyleRecipeFilters(recipe) {
  const filters = [];
  const toneCurve = buildToneCurveFilter(recipe);
  const eq = buildEqFilter(recipe);
  const vibrance = buildVibranceFilter(recipe);
  const colorbalance = (recipe.temperature ?? 0) !== 0 || (recipe.tint ?? 0) !== 0
    ? buildColorBalanceFilter(recipe)
    : null;
  if (toneCurve) filters.push(toneCurve);
  if (eq) filters.push(eq);
  if (vibrance) filters.push(vibrance);
  if (colorbalance) filters.push(colorbalance);
  return filters;
}

/**
 * Maps B2's bounded black endpoint/toe control into a monotonic master curve.
 * Positive values lift code-zero blacks by at most 5.5%; negative values keep
 * code zero at zero and add at most 4% density at the shadow anchor. That
 * avoids impossible negative blacks and prevents a maximum treatment from
 * becoming either a grey wash or a crushed-black transform.
 */
export function buildReferenceToneCurvePoints(recipe = {}) {
  const blackLift = boundedStylePrimitive(recipe.blackLift, "blackLift");
  const { shadowPoint: baseShadowPoint, highlightPoint } = buildToneCurvePoints(recipe);
  const liftMagnitude = perceptualAdjustmentMagnitude(blackLift);
  const blackPoint = liftMagnitude > 0 ? liftMagnitude * BLACK_LIFT_MAX : 0;
  const shadowPoint = Math.max(
    blackPoint + TONE_CURVE_SHADOW_RANGE.min,
    Math.min(
      TONE_CURVE_SHADOW_RANGE.max,
      baseShadowPoint + (liftMagnitude < 0 ? liftMagnitude * BLACK_DENSITY_SHADOW_MAX : 0)
    )
  );
  return Object.freeze({ blackPoint, shadowPoint, highlightPoint });
}

export function buildReferenceToneCurveFilter(recipe = {}, { protectColorbalanceHighlights = false } = {}) {
  const blackLift = boundedStylePrimitive(recipe.blackLift, "blackLift");
  if (blackLift === 0 && !protectColorbalanceHighlights) return buildToneCurveFilter(recipe);
  const { blackPoint, shadowPoint, highlightPoint } = blackLift === 0
    ? { blackPoint: 0, ...buildToneCurvePoints(recipe) }
    : buildReferenceToneCurvePoints(recipe);
  // Apply a small endpoint roll-off only after B2's non-lightness-preserving
  // color balance. It protects bright practicals and facial highlights from
  // the color transform without reducing the treatment's midtone authority.
  const endpoint = protectColorbalanceHighlights ? 0.98 : 1;
  return `curves=master='0/${blackPoint.toFixed(4)} 0.25/${shadowPoint.toFixed(4)} 0.75/${highlightPoint.toFixed(4)} 1/${endpoint.toFixed(4)}'`;
}

/**
 * B2 custom treatments intentionally use their own stable compiler order.
 * EQ (including gamma) shapes the broad exposure/midtone response first.
 * Selective color and color balance follow, then the monotonic curve is last
 * so its black/highlight anchors protect the final chroma-adjusted image.
 * Existing B1 profile compilation is not reordered.
 *
 * `colorbalance`'s preserve-lightness mode can collapse high-chroma skin into
 * grey after this particular EQ → curve → vibrance sequence. Reference
 * treatment therefore keeps the full bounded color authority but disables
 * that nonlinear lightness-preservation branch. B1 remains on its historical
 * `pl=1` path through buildStyleRecipeFilters().
 */
export function buildReferenceStyleTreatmentFilters(recipe = {}) {
  const canonical = createCanonicalReferenceStyleTreatment({ version: 2, recipe }).recipe;
  const filters = [];
  const eq = buildEqFilter(canonical, { includeMidtoneGamma: canonical.midtoneGamma !== 0 });
  const vibrance = buildVibranceFilter(canonical);
  const colorbalance = buildReferenceColorBalanceFilter(canonical);
  // A reference treatment with no B2 primitive and no color balance is
  // mathematically identical to the established B1 recipe path.
  if (!colorbalance && canonical.blackLift === 0 && canonical.midtoneGamma === 0) {
    return buildStyleRecipeFilters(canonical);
  }
  const toneCurve = buildReferenceToneCurveFilter(canonical, { protectColorbalanceHighlights: Boolean(colorbalance) });
  if (eq) filters.push(eq);
  if (vibrance) filters.push(vibrance);
  if (colorbalance) filters.push(colorbalance);
  if (toneCurve) filters.push(toneCurve);
  return filters;
}

/** Resolves only semantic catalog identifiers into server-owned FFmpeg filters. */
export function compileStyleProfileForExecution(operation) {
  const compiled = compileStyleProfile({
    profileId: operation.profileId,
    ...(operation.strength === undefined ? {} : { strength: operation.strength }),
    ...(operation.constraints === undefined ? {} : { constraints: operation.constraints })
  });
  return { compiled, filters: buildStyleRecipeFilters(compiled.recipe) };
}

export function buildStyleProfileFilters(operation) {
  return compileStyleProfileForExecution(operation).filters;
}

export function createStyleProfileExecutionDiagnostic(operation, { jobId = null, scope = "global" } = {}) {
  const { compiled, filters } = compileStyleProfileForExecution(operation);
  return {
    ...(jobId ? { jobId } : {}),
    scope,
    profileId: compiled.profileId,
    profileVersion: compiled.profileVersion,
    strength: compiled.strength,
    constraints: compiled.constraints,
    recipe: compiled.recipe,
    filters
  };
}

function logStyleProfileExecution(operation, options) {
  const diagnostic = createStyleProfileExecutionDiagnostic(operation, options);
  if (diagnostic.jobId) console.info("Cliponaut style profile applied:", diagnostic);
  return diagnostic.filters;
}

async function applyVisualAdjustment(input, output, operation, executionController) {
  await exec(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", buildVisualAdjustmentFilters(operation).join(","), ...VIDEO_ENCODING_ARGS, output], { executionController });
}

async function applyStyleProfile(input, output, operation, executionController, jobId) {
  const filters = logStyleProfileExecution(operation, { jobId, scope: operation.sourceId || "global" });
  await exec(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", filters.join(","), ...VIDEO_ENCODING_ARGS, output], { executionController });
}

async function cutClip(input, output, start, end, executionController) {
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", start.toString(), "-to", end.toString(), "-i", input,
    ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
}

function buildZoomFilter(operation, { width, height }) {
  // The cosine envelope enters and exits at 1x, avoiding an abrupt crop at either boundary.
  const envelope = `if(between(t\\,${operation.start}\\,${operation.end})\\,1+(${operation.amount - 1})*(0.5-0.5*cos(2*PI*(t-${operation.start})/(${operation.end - operation.start})))\\,1)`;
  return `scale=w='trunc(${width}*${envelope}/2)*2':h='trunc(${height}*${envelope}/2)*2':eval=frame,crop=${width}:${height}:(in_w-out_w)/2:(in_h-out_h)/2`;
}

function atempoFilters(factor) {
  const filters = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining}`);
  return filters.join(",");
}

function trimArguments(start, end) {
  return [start !== undefined ? `start=${start}` : null, end !== undefined ? `end=${end}` : null].filter(Boolean).join(":");
}

async function applyTemporalOperations(input, output, trim, speed, executionController) {
  const trimStart = trim?.start ?? 0;
  const trimEnd = trim?.end;

  if (!speed) {
    if (!trim) return input;
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", trim.start.toString(), "-to", trim.end.toString(), "-i", input,
      ...VIDEO_ENCODING_ARGS, output
    ], { executionController });
    return output;
  }

  if (speed.start === undefined) {
    const window = trimArguments(trimStart, trimEnd);
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-filter_complex",
      `[0:v]trim=${window},setpts=(PTS-STARTPTS)/${speed.factor}[v];[0:a]atrim=${window},asetpts=PTS-STARTPTS,${atempoFilters(speed.factor)}[a]`,
      "-map", "[v]", "-map", "[a]", ...VIDEO_ENCODING_ARGS, output
    ], { executionController });
    return output;
  }

  const speedStart = Math.max(trimStart, speed.start);
  const speedEnd = trimEnd === undefined ? speed.end : Math.min(trimEnd, speed.end);
  if (speedEnd <= speedStart) return applyTemporalOperations(input, output, trim, null, executionController);

  const segments = [];
  if (speedStart > trimStart) segments.push({ start: trimStart, end: speedStart, factor: 1 });
  segments.push({ start: speedStart, end: speedEnd, factor: speed.factor });
  if (trimEnd === undefined || speedEnd < trimEnd) segments.push({ start: speedEnd, end: trimEnd, factor: 1 });

  const filters = [];
  const inputs = [];
  for (const [index, segment] of segments.entries()) {
    const window = trimArguments(segment.start, segment.end);
    filters.push(`[0:v]trim=${window},setpts=(PTS-STARTPTS)${segment.factor === 1 ? "" : `/${segment.factor}`}[v${index}]`);
    filters.push(`[0:a]atrim=${window},asetpts=PTS-STARTPTS${segment.factor === 1 ? "" : `,${atempoFilters(segment.factor)}`}[a${index}]`);
    inputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${inputs.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`);

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]", ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
  return output;
}

async function getDuration(input, executionController) {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], { executionController });
  const duration = Number.parseFloat(stdout);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unable to determine processed video duration");
  return duration;
}

async function applyFade(input, output, fade, executionController) {
  if (!fade) return input;
  const duration = await getDuration(input, executionController);
  const requestedDuration = fade.mode === "both" ? fade.duration * 2 : fade.duration;
  if (requestedDuration > duration) throw new Error("Fade duration exceeds the resulting video duration");

  const videoFilters = [];
  const audioFilters = [];
  if (fade.mode === "in" || fade.mode === "both") {
    videoFilters.push(`fade=t=in:st=0:d=${fade.duration}`);
    audioFilters.push(`afade=t=in:st=0:d=${fade.duration}`);
  }
  if (fade.mode === "out" || fade.mode === "both") {
    const start = Math.max(0, duration - fade.duration);
    videoFilters.push(`fade=t=out:st=${start}:d=${fade.duration}`);
    audioFilters.push(`afade=t=out:st=${start}:d=${fade.duration}`);
  }

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", videoFilters.join(","), "-af", audioFilters.join(","),
    ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
  return output;
}

async function applyAudioControls(input, output, volume, audioFade, executionController) {
  if (!volume && !audioFade) return input;
  const audioFilters = [];
  if (volume) audioFilters.push(`volume=${volume.factor}`);
  if (audioFade) {
    const duration = await getDuration(input, executionController);
    const requestedDuration = audioFade.mode === "both" ? audioFade.duration * 2 : audioFade.duration;
    if (requestedDuration > duration) throw new Error("Audio fade duration exceeds the resulting video duration");
    if (audioFade.mode === "in" || audioFade.mode === "both") audioFilters.push(`afade=t=in:st=0:d=${audioFade.duration}`);
    if (audioFade.mode === "out" || audioFade.mode === "both") audioFilters.push(`afade=t=out:st=${Math.max(0, duration - audioFade.duration)}:d=${audioFade.duration}`);
  }
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:v:0", "-map", "0:a:0",
    "-af", audioFilters.join(","), ...AUDIO_ONLY_ENCODING_ARGS, output
  ], { executionController });
  return output;
}

function safeRendererWarnings(stderr = "") {
  return stderr.split(/\r?\n/)
    .filter((line) => /(?:libass|font)/i.test(line))
    .slice(0, 5)
    .map((line) => line
      .replace(/(?:[A-Za-z]:)?[/\\][^\s'\"]+/g, "[redacted-path]")
      .slice(0, 240));
}

async function applyTitles(input, output, titles, { width, height, tempDirectory, executionController, captionDiagnostics = null }) {
  if (!titles.length) return input;
  const assPath = await writeTitleAssFile(titles, { width, height, tempDirectory });
  const { stderr } = await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", captionDiagnostics ? "warning" : "error", "-i", input,
    "-vf", buildAssFilter(assPath), ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
  if (captionDiagnostics) {
    console.info("Caption ASS render completed:", {
      ...captionDiagnostics,
      rendererWarnings: safeRendererWarnings(stderr)
    });
  }
  return output;
}

/** A B2B-only, one-frame safeguard; it never changes ordinary title rendering. */
export function titleReadabilityForLuma(luma) {
  if (!Number.isFinite(luma) || luma < 0.62) return null;
  return Object.freeze({ outline: 1.45, shadow: 0.3 });
}

async function sampleTitleFrameLuma(input, seconds, executionController) {
  try {
    const { stderr } = await exec(FFMPEG, [
      "-hide_banner", "-loglevel", "info", "-ss", String(seconds), "-i", input,
      "-frames:v", "1", "-vf", "signalstats,metadata=print", "-f", "null", "-"
    ], { executionController });
    const match = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    const average = Number(match?.[1]);
    return Number.isFinite(average) ? average / 255 : null;
  } catch (error) {
    if (error instanceof EditExecutionCancelledError) throw error;
    return null;
  }
}

async function prepareTargetAwareTitles(titles, input, executionController) {
  const prepared = [];
  for (const title of titles) {
    if (title.readability?.mode !== "target_aware") {
      prepared.push(title);
      continue;
    }
    const sampleTime = title.start + Math.min(0.5, (title.end - title.start) / 2);
    const readability = titleReadabilityForLuma(await sampleTitleFrameLuma(input, sampleTime, executionController));
    prepared.push(readability ? { ...title, readability } : { ...title, readability: null });
  }
  return prepared;
}

/** Executes only capabilities registered in the validated edit plan. */
export async function executeEditPlan({ inputPaths, media, plan, sourceCatalog = [], tempDirectory, exportQuality = "standard", executionController, captionCues = [], captionCorrection = null, jobId = null }) {
  const sequence = plan.operations.find((operation) => operation.type === "sequence");
  const crop = plan.operations.find((operation) => operation.type === "crop");
  const sourceById = new Map(sourceCatalog.map((source) => [source.sourceId, source]));
  const selectedSourceIndexes = sequence
    ? [...new Set(sequence.clips.map((clip) => sourceById.get(clip.sourceId).index))]
    : inputPaths.map((_, index) => index);
  const selectedMedia = selectedSourceIndexes.map((index) => media[index]);
  const profile = createMediaProfile({ media: selectedMedia, exportQuality, aspectRatio: crop?.aspect_ratio });
  const normalizedPaths = new Map();
  for (const index of selectedSourceIndexes) {
    const normalizedPath = path.join(tempDirectory, `normalized-${index}.mp4`);
    await normalize(inputPaths[index], normalizedPath, media[index], profile, executionController);
    normalizedPaths.set(index, normalizedPath);
  }

  if (sequence) {
    // Server-owned source-time order before clip cutting and sequence assembly.
    for (const operation of orderedVisualOperations(plan.operations, { sourceScoped: true })) {
      const { type } = operation;
      const source = sourceById.get(operation.sourceId);
      const adjustedPath = path.join(tempDirectory, `${type}-${source.index}.mp4`);
      if (type === "color_grade") await applyColorGrade(normalizedPaths.get(source.index), adjustedPath, operation.style, executionController);
      else if (type === "style_profile") await applyStyleProfile(normalizedPaths.get(source.index), adjustedPath, operation, executionController, jobId);
      else if (type === "reference_style_treatment") await applyReferenceStyleTreatment(normalizedPaths.get(source.index), adjustedPath, operation, executionController);
      else await applyVisualAdjustment(normalizedPaths.get(source.index), adjustedPath, operation, executionController);
      normalizedPaths.set(source.index, adjustedPath);
    }
  }

  let baseVideo = normalizedPaths.get(selectedSourceIndexes[0]);
  if (sequence) {
    const clipPaths = [];
    for (const [index, clip] of sequence.clips.entries()) {
      const source = sourceById.get(clip.sourceId);
      const clipPath = path.join(tempDirectory, `sequence-${index}.mp4`);
      await cutClip(normalizedPaths.get(source.index), clipPath, clip.start, clip.end, executionController);
      clipPaths.push(clipPath);
    }
    if (clipPaths.length > 1) {
      const sequencePath = path.join(tempDirectory, "sequence.mp4");
      await mergeVideos(clipPaths, sequencePath, executionController);
      baseVideo = sequencePath;
    } else {
      [baseVideo] = clipPaths;
    }
  } else if (plan.operations.some((operation) => operation.type === "merge")) {
    const mergedPath = path.join(tempDirectory, "merged.mp4");
    await mergeVideos(selectedSourceIndexes.map((index) => normalizedPaths.get(index)), mergedPath, executionController);
    baseVideo = mergedPath;
  }

  // Source-time visual phase establishes the canvas and applies color/zoom. Temporal edits then
  // establish the final output timeline, so title timestamps are never shifted by trim or speed.
  const cropSettings = getCropSettings(crop, profile);
  const filters = cropSettings.filter ? [cropSettings.filter] : [];
  for (const operation of plan.operations) if (operation.type === "zoom") filters.push(buildZoomFilter(operation, cropSettings));
  // Server-owned global order after sequence/merge has established the output timeline.
  for (const operation of orderedVisualOperations(plan.operations)) {
    if (operation.type === "color_grade") filters.push(...COLOR_PRESETS[operation.style]);
    else if (operation.type === "style_profile") filters.push(...logStyleProfileExecution(operation, { jobId, scope: "global" }));
    else if (operation.type === "reference_style_treatment") filters.push(...buildReferenceStyleTreatmentFilters(operation.treatment.recipe));
    else filters.push(...buildVisualAdjustmentFilters(operation));
  }

  let processed = baseVideo;
  if (filters.length) {
    const processedPath = path.join(tempDirectory, "processed.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", baseVideo, "-vf", filters.join(","),
      ...VIDEO_ENCODING_ARGS, processedPath
    ], { executionController });
    processed = processedPath;
  }

  const trim = plan.operations.find((operation) => operation.type === "trim");
  const speed = plan.operations.find((operation) => operation.type === "speed");
  const audioVolume = plan.operations.find((operation) => operation.type === "audio_volume");
  const audioFade = plan.operations.find((operation) => operation.type === "audio_fade");
  const fade = plan.operations.find((operation) => operation.type === "fade");
  const timedVideo = await applyTemporalOperations(processed, path.join(tempDirectory, "timed.mp4"), trim, speed, executionController);
  const titles = plan.operations.filter((operation) => operation.type === "title");
  const captionStyle = plan.operations.find((operation) => operation.type === "captions");
  // Captions must use the final output timeline of the exact plan that just rendered
  // trim/speed, rather than a separately transformed worker-side schedule.
  let finalCaptionCues = captionStyle ? mapCaptionCuesToOutput(captionCues, plan, sourceCatalog) : [];
  if (captionStyle && !finalCaptionCues.length) throw new CaptionError("CAPTION_NO_USABLE_SPEECH");
  if (captionCorrection) finalCaptionCues = applyCaptionCorrection(finalCaptionCues, captionCorrection);
  const captionLayers = captionStyle ? finalCaptionCues.map((cue) => ({
    text: cue.text, start: cue.start, end: cue.end, position: captionStyle.position,
    runs: [{ text: cue.text, font: captionStyle.font, size: captionStyle.size, color: captionStyle.color, weight: captionStyle.weight }]
  })) : [];
  const firstCaptionCue = finalCaptionCues[0];
  const lastCaptionCue = finalCaptionCues.at(-1);
  const captionDiagnostics = captionStyle ? {
    jobId,
    sourceCueCount: captionCues.length,
    finalCueCount: finalCaptionCues.length,
    firstCue: firstCaptionCue ? { start: firstCaptionCue.start, end: firstCaptionCue.end } : null,
    lastCue: lastCaptionCue ? { start: lastCaptionCue.start, end: lastCaptionCue.end } : null,
    assLayerCount: captionLayers.length,
    renderWidth: cropSettings.width,
    renderHeight: cropSettings.height,
    fontId: captionStyle.font,
    fontFamily: FONT_CATALOG[captionStyle.font]?.family || null,
    resolvedSize: titleFontSize(captionStyle.size, cropSettings.height),
    color: captionStyle.color,
    position: captionStyle.position,
    weight: captionStyle.weight
  } : null;
  if (captionDiagnostics) console.info("Caption render prepared:", captionDiagnostics);
  const readableTitles = await prepareTargetAwareTitles(titles, timedVideo, executionController);
  const titledVideo = await applyTitles(timedVideo, path.join(tempDirectory, "titled.mp4"), [...readableTitles, ...captionLayers], {
    width: cropSettings.width, height: cropSettings.height, tempDirectory, executionController, captionDiagnostics
  });
  const audioControlledVideo = await applyAudioControls(titledVideo, path.join(tempDirectory, "audio-controlled.mp4"), audioVolume, audioFade, executionController);
  const finalVideo = await applyFade(audioControlledVideo, path.join(tempDirectory, "faded.mp4"), fade, executionController);
  if (captionDiagnostics) console.info("Caption final output:", {
    jobId,
    captionsRendered: true,
    audioOnlyPostProcessApplied: Boolean(audioVolume || audioFade),
    audiovisualFadeApplied: Boolean(fade)
  });
  return finalVideo;
}

import { spawn } from "child_process";
import { readFile, unlink } from "fs/promises";
import path from "path";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { applyCaptionCorrection, CaptionError, mapCaptionCuesToOutput } from "@/lib/editor-core/caption-engine";
import { buildAssFilter, writeTitleAssFile } from "@/lib/title-renderer";
import { FONT_CATALOG, titleFontSize } from "@/lib/title-config";
import { buildNormalizationFilter, createMediaProfile, getCropSettings } from "@/lib/editor-core/media-profile";

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const FFMPEG_TERMINATION_GRACE_MS = 5_000;
const VIDEO_ENCODING_ARGS = [
  "-threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"
];

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

function safeRendererWarnings(stderr = "") {
  return stderr.split(/\r?\n/)
    .filter((line) => /(?:libass|font)/i.test(line))
    .slice(0, 5)
    .map((line) => line
      .replace(/(?:[A-Za-z]:)?[/\\][^\s'\"]+/g, "[redacted-path]")
      .slice(0, 240));
}

function summarizeAssDocument(document) {
  const events = [...document.matchAll(/^Dialogue:\s*\d+,([^,]+),([^,]+)/gm)];
  return {
    assDialogueCount: events.length,
    firstDialogue: events[0] ? { start: events[0][1], end: events[0][2] } : null,
    lastDialogue: events.at(-1) ? { start: events.at(-1)[1], end: events.at(-1)[2] } : null
  };
}

async function probeRenderedDimensions(input, executionController) {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", input
  ], { executionController });
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error("Invalid rendered dimensions");
  return { width, height };
}

function captionRegions(width, height) {
  const regionWidth = Math.max(2, Math.floor(width * 0.7 / 2) * 2);
  const regionHeight = Math.max(2, Math.floor(height * 0.35 / 2) * 2);
  const x = Math.floor((width - regionWidth) / 2);
  return {
    caption: { width: regionWidth, height: regionHeight, x, y: Math.min(height - regionHeight, Math.round(height * 0.55)) },
    control: { width: regionWidth, height: regionHeight, x, y: Math.round(height * 0.05) }
  };
}

async function pixelDifferenceAtTime(before, after, time, region, output, executionController) {
  try {
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", time.toString(), "-i", before,
      "-ss", time.toString(), "-i", after, "-filter_complex",
      `[0:v][1:v]blend=all_mode=difference,crop=${region.width}:${region.height}:${region.x}:${region.y},format=gray`,
      "-frames:v", "1", "-f", "rawvideo", output
    ], { executionController });
    const pixels = await readFile(output);
    return pixels.reduce((sum, value) => sum + value, 0);
  } finally {
    await unlink(output).catch(() => {});
  }
}

async function collectCaptionRenderEvidence({ assPath, untitledVideo, titledVideo, tempDirectory, cue, executionController }) {
  try {
    const [ass, dimensions] = await Promise.all([
      readFile(assPath, "utf8"),
      probeRenderedDimensions(titledVideo, executionController)
    ]);
    const time = (cue.start + cue.end) / 2;
    const regions = captionRegions(dimensions.width, dimensions.height);
    // The execution controller owns one active child, so diagnostics remain sequential.
    const captionPixelDifference = await pixelDifferenceAtTime(
      untitledVideo, titledVideo, time, regions.caption,
      path.join(tempDirectory, "caption-pixel-difference.raw"), executionController
    );
    const controlPixelDifference = await pixelDifferenceAtTime(
      untitledVideo, titledVideo, time, regions.control,
      path.join(tempDirectory, "caption-control-difference.raw"), executionController
    );
    return {
      ...summarizeAssDocument(ass),
      titledWidth: dimensions.width,
      titledHeight: dimensions.height,
      pixelSampleTime: time,
      captionRegionPixelDifference: captionPixelDifference,
      controlRegionPixelDifference: controlPixelDifference
    };
  } catch {
    // Rendering has already succeeded; observability must never replace it with a diagnostic failure.
    return { renderEvidenceUnavailable: true };
  }
}

async function applyTitles(input, output, titles, { width, height, tempDirectory, executionController, captionDiagnostics = null }) {
  if (!titles.length) return input;
  const assPath = await writeTitleAssFile(titles, { width, height, tempDirectory });
  const { stderr } = await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", captionDiagnostics ? "warning" : "error", "-i", input,
    "-vf", buildAssFilter(assPath), ...VIDEO_ENCODING_ARGS, output
  ], { executionController });
  if (captionDiagnostics) {
    const renderEvidence = await collectCaptionRenderEvidence({
      assPath, untitledVideo: input, titledVideo: output, tempDirectory,
      cue: captionDiagnostics.firstCue, executionController
    });
    console.info("Caption ASS render completed:", {
      ...captionDiagnostics,
      rendererWarnings: safeRendererWarnings(stderr),
      ...renderEvidence
    });
  }
  return output;
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
    for (const operation of plan.operations) {
      if (operation.type !== "color_grade" || !operation.sourceId) continue;
      const source = sourceById.get(operation.sourceId);
      const gradedPath = path.join(tempDirectory, `graded-${source.index}.mp4`);
      await applyColorGrade(normalizedPaths.get(source.index), gradedPath, operation.style, executionController);
      normalizedPaths.set(source.index, gradedPath);
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
  for (const operation of plan.operations) {
    if (operation.type === "zoom") filters.push(buildZoomFilter(operation, cropSettings));
    if (operation.type === "color_grade" && !operation.sourceId) filters.push(...COLOR_PRESETS[operation.style]);
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
  const titledVideo = await applyTitles(timedVideo, path.join(tempDirectory, "titled.mp4"), [...titles, ...captionLayers], {
    width: cropSettings.width, height: cropSettings.height, tempDirectory, executionController, captionDiagnostics
  });
  const finalVideo = await applyFade(titledVideo, path.join(tempDirectory, "faded.mp4"), fade, executionController);
  if (captionDiagnostics) console.info("Caption final output:", { jobId, finalOutputUsesTitledVideo: finalVideo === titledVideo });
  return finalVideo;
}

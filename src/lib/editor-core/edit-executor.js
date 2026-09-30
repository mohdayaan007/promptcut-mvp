import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { buildTitleFilter } from "@/lib/title-renderer";
import { buildNormalizationFilter, createMediaProfile, getCropSettings } from "@/lib/editor-core/media-profile";

const exec = (cmd, args) => promisify(execFile)(cmd, args, { maxBuffer: 1024 * 1024 * 20 });
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const VIDEO_ENCODING_ARGS = [
  "-threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"
];

async function normalize(input, output, media, profile) {
  const mappingArgs = media.hasAudio
    ? ["-map", "0:v:0", "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0"]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0", "-shortest"];

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", input,
    ...mappingArgs, "-vf", buildNormalizationFilter(profile), ...VIDEO_ENCODING_ARGS, output
  ]);
}

async function mergeVideos(inputs, output) {
  const filterInputs = inputs.map((_, index) => `[${index}:v][${index}:a]`).join("");
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", ...inputs.flatMap((input) => ["-i", input]), "-filter_complex",
    `${filterInputs}concat=n=${inputs.length}:v=1:a=1[v][a]`, "-map", "[v]", "-map", "[a]",
    ...VIDEO_ENCODING_ARGS, output
  ]);
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

async function applyTemporalOperations(input, output, trim, speed) {
  const trimStart = trim?.start ?? 0;
  const trimEnd = trim?.end;

  if (!speed) {
    if (!trim) return input;
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", trim.start.toString(), "-to", trim.end.toString(), "-i", input,
      ...VIDEO_ENCODING_ARGS, output
    ]);
    return output;
  }

  if (speed.start === undefined) {
    const window = trimArguments(trimStart, trimEnd);
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-filter_complex",
      `[0:v]trim=${window},setpts=(PTS-STARTPTS)/${speed.factor}[v];[0:a]atrim=${window},asetpts=PTS-STARTPTS,${atempoFilters(speed.factor)}[a]`,
      "-map", "[v]", "-map", "[a]", ...VIDEO_ENCODING_ARGS, output
    ]);
    return output;
  }

  const speedStart = Math.max(trimStart, speed.start);
  const speedEnd = trimEnd === undefined ? speed.end : Math.min(trimEnd, speed.end);
  if (speedEnd <= speedStart) return applyTemporalOperations(input, output, trim, null);

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
  ]);
  return output;
}

async function getDuration(input) {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input]);
  const duration = Number.parseFloat(stdout);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unable to determine processed video duration");
  return duration;
}

async function applyFade(input, output, fade) {
  if (!fade) return input;
  const duration = await getDuration(input);
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
  ]);
  return output;
}

/** Executes only capabilities registered in the validated edit plan. */
export async function executeEditPlan({ inputPaths, media, plan, tempDirectory, exportQuality = "standard" }) {
  const profile = createMediaProfile({ media, exportQuality });
  const normalizedPaths = inputPaths.map((_, index) => path.join(tempDirectory, `normalized-${index}.mp4`));
  for (const [index, inputPath] of inputPaths.entries()) {
    await normalize(inputPath, normalizedPaths[index], media[index], profile);
  }

  let baseVideo = normalizedPaths[0];
  if (plan.operations.some((operation) => operation.type === "merge")) {
    const mergedPath = path.join(tempDirectory, "merged.mp4");
    await mergeVideos(normalizedPaths, mergedPath);
    baseVideo = mergedPath;
  }

  // Source-time visual phase: center crop establishes the output canvas before zoom, then
  // color and titles are composited. Trim/speed run next and can change duration; fades run last.
  const crop = plan.operations.find((operation) => operation.type === "crop");
  const cropSettings = getCropSettings(crop, profile);
  const filters = cropSettings.filter ? [cropSettings.filter] : [];
  for (const operation of plan.operations) {
    if (operation.type === "zoom") filters.push(buildZoomFilter(operation, cropSettings));
    if (operation.type === "color_grade") filters.push(...COLOR_PRESETS[operation.style]);
    if (operation.type === "title") filters.push(buildTitleFilter(operation));
  }

  let processed = baseVideo;
  if (filters.length) {
    const processedPath = path.join(tempDirectory, "processed.mp4");
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", baseVideo, "-vf", filters.join(","),
      ...VIDEO_ENCODING_ARGS, processedPath
    ]);
    processed = processedPath;
  }

  const trim = plan.operations.find((operation) => operation.type === "trim");
  const speed = plan.operations.find((operation) => operation.type === "speed");
  const fade = plan.operations.find((operation) => operation.type === "fade");
  const timedVideo = await applyTemporalOperations(processed, path.join(tempDirectory, "timed.mp4"), trim, speed);
  return applyFade(timedVideo, path.join(tempDirectory, "faded.mp4"), fade);
}

import { writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { buildTitleFilter } from "@/lib/title-renderer";

const exec = (cmd, args) => promisify(execFile)(cmd, args, { maxBuffer: 1024 * 1024 * 20 });
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-noautorotate", "-i", input,
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1",
    "-threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", output
  ]);
}

async function mergeVideos(first, second, output) {
  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", first, "-i", second, "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v];[0:a][1:a]concat=n=2:v=0:a=1[a]", "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output
  ]);
}

function getCropSettings(operation) {
  if (!operation || operation.aspect_ratio === "16:9") {
    return { width: 1280, height: 720, filter: "crop=1280:720" };
  }
  if (operation.aspect_ratio === "9:16") {
    return { width: 720, height: 1280, filter: "crop=405:720:(iw-ow)/2:0,scale=720:1280" };
  }
  return { width: 720, height: 720, filter: "crop=720:720:(iw-ow)/2:0,scale=720:720" };
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
  return [start !== undefined ? `start=${start}` : null, end !== undefined ? `end=${end}` : null]
    .filter(Boolean)
    .join(":");
}

async function applyTemporalOperations(input, output, trim, speed) {
  const trimStart = trim?.start ?? 0;
  const trimEnd = trim?.end;

  if (!speed) {
    if (!trim) return input;
    // Preserve the established trim command for existing trim-only requests.
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", trim.start.toString(), "-to", trim.end.toString(), "-i", input,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output
    ]);
    return output;
  }

  if (speed.start === undefined) {
    const window = trimArguments(trimStart, trimEnd);
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", input, "-filter_complex",
      `[0:v]trim=${window},setpts=(PTS-STARTPTS)/${speed.factor}[v];[0:a]atrim=${window},asetpts=PTS-STARTPTS,${atempoFilters(speed.factor)}[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output
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
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output
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
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", output
  ]);
  return output;
}

/** Executes only capabilities registered in the validated edit plan. */
export async function executeEditPlan({ file1, file2, plan, tempDirectory }) {
  const paths = Object.fromEntries(["v1", "v2", "n1", "n2", "merged", "processed", "timed", "faded", "output"].map((name) => [name, path.join(tempDirectory, `${name}.mp4`)]));
  await writeFile(paths.v1, Buffer.from(await file1.arrayBuffer()));
  await normalize(paths.v1, paths.n1);

  let baseVideo = paths.n1;
  if (plan.operations.some((operation) => operation.type === "merge")) {
    await writeFile(paths.v2, Buffer.from(await file2.arrayBuffer()));
    await normalize(paths.v2, paths.n2);
    await mergeVideos(paths.n1, paths.n2, paths.merged);
    baseVideo = paths.merged;
  }

  // Source-time visual phase: center crop establishes the output canvas before zoom, then
  // color and titles are composited. Trim/speed run next and can change duration; fades run last.
  const crop = plan.operations.find((operation) => operation.type === "crop");
  const cropSettings = getCropSettings(crop);
  const filters = crop ? [cropSettings.filter] : [];
  for (const operation of plan.operations) {
    if (operation.type === "zoom") filters.push(buildZoomFilter(operation, cropSettings));
    if (operation.type === "color_grade") filters.push(...COLOR_PRESETS[operation.style]);
    if (operation.type === "title") filters.push(buildTitleFilter(operation));
  }

  let processed = baseVideo;
  if (filters.length) {
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "info", "-i", baseVideo, "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "128k", paths.processed
    ]);
    processed = paths.processed;
  }

  const trim = plan.operations.find((operation) => operation.type === "trim");
  const speed = plan.operations.find((operation) => operation.type === "speed");
  const fade = plan.operations.find((operation) => operation.type === "fade");
  const timedVideo = await applyTemporalOperations(processed, paths.timed, trim, speed);
  const finalVideo = await applyFade(timedVideo, paths.faded, fade);

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", finalVideo, "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", paths.output
  ]);

  return paths.output;
}

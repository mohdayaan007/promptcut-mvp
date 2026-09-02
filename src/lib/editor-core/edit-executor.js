import { writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { buildTitleFilter } from "@/lib/title-renderer";

const exec = (cmd, args) => promisify(execFile)(cmd, args, { maxBuffer: 1024 * 1024 * 20 });
const FFMPEG = "ffmpeg";

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

/** Executes only capabilities registered in the validated edit plan. */
export async function executeEditPlan({ file1, file2, plan, tempDirectory }) {
  const paths = Object.fromEntries(["v1", "v2", "n1", "n2", "merged", "processed", "trimmed", "output"].map((name) => [name, path.join(tempDirectory, `${name}.mp4`)]));
  await writeFile(paths.v1, Buffer.from(await file1.arrayBuffer()));
  await normalize(paths.v1, paths.n1);

  let baseVideo = paths.n1;
  if (plan.operations.some((operation) => operation.type === "merge")) {
    await writeFile(paths.v2, Buffer.from(await file2.arrayBuffer()));
    await normalize(paths.v2, paths.n2);
    await mergeVideos(paths.n1, paths.n2, paths.merged);
    baseVideo = paths.merged;
  }

  const filters = [];
  for (const operation of plan.operations) {
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
  let finalVideo = processed;
  if (trim) {
    await exec(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error", "-ss", trim.start.toString(), "-to", trim.end.toString(), "-i", processed,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", paths.trimmed
    ]);
    finalVideo = paths.trimmed;
  }

  await exec(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", finalVideo, "-c:v", "libx264", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", paths.output
  ]);

  return paths.output;
}

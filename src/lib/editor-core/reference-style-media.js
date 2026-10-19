import { spawn as nodeSpawn } from "child_process";
import { readFile } from "fs/promises";
import path from "path";
import { measureReferenceRgbFrame, summarizeReferenceFrameMetrics } from "@/lib/editor-core/reference-style-metrics";
import { buildReferenceStyleTreatmentFilters, EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";
import { ReferenceStyleError } from "@/lib/editor-core/reference-style-matching";

function run(cmd, args, { executionController, spawn = nodeSpawn, binary = false } = {}) {
  executionController?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let stderr = ""; let settled = false;
    const finish = (error, value) => { if (!settled) { settled = true; executionController?.detach(child); error ? reject(error) : resolve(value); } };
    executionController?.attach(child);
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(executionController?.isCancelled() ? new EditExecutionCancelledError() : error));
    child.once("close", (code) => executionController?.isCancelled() ? finish(new EditExecutionCancelledError()) : code === 0 ? finish(null, binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString()) : finish(new Error(stderr || `${cmd} failed`)));
  });
}

const IMAGE_MAGIC = {
  "image/jpeg": (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  "image/png": (data) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "image/webp": (data) => data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP"
};

/** Verifies decoded dimensions and content signature; declared MIME is never trusted alone. */
export async function validateReferenceImageFile({ inputPath, type, executionController, read = readFile }) {
  const bytes = await read(inputPath);
  if (!IMAGE_MAGIC[type]?.(bytes)) throw new ReferenceStyleError("REFERENCE_INVALID_IMAGE", "This reference image could not be verified.");
  let parsed;
  try { parsed = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", inputPath], { executionController })); }
  catch { throw new ReferenceStyleError("REFERENCE_INVALID_IMAGE", "This reference image could not be verified."); }
  const stream = parsed.streams?.find((entry) => entry.codec_type === "video");
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width < 32 || stream.height < 32 || stream.width > 12_000 || stream.height > 12_000) {
    throw new ReferenceStyleError("REFERENCE_INVALID_IMAGE", "This reference image could not be verified.");
  }
  return Object.freeze({ width: stream.width, height: stream.height });
}

/** Five evenly distributed samples, bounded to avoid decoding an unbounded image sequence. */
export async function extractTargetReferenceFrames({ inputPath, duration, scratchDirectory, executionController, count = 3 }) {
  const timestamps = Array.from({ length: count }, (_, index) => Math.max(0, Math.min(Math.max(0, duration - 0.05), duration * ((index + 1) / (count + 1)))));
  const frames = [];
  for (const [index, timestamp] of timestamps.entries()) {
    const imagePath = path.join(scratchDirectory, `reference-target-${index}.jpg`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(timestamp), "-i", inputPath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "3", imagePath], { executionController });
    const raw = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { executionController, binary: true });
    frames.push({ timestamp, imagePath, metrics: measureReferenceRgbFrame(new Uint8Array(raw)) });
  }
  return Object.freeze({ frames: Object.freeze(frames), metrics: summarizeReferenceFrameMetrics(frames.map((frame) => frame.metrics)) });
}

/**
 * Renders only the already-selected representative frames through the B2
 * chain. This deliberately never creates a proxy video: it is a bounded,
 * scratch-only check before the single production render.
 */
export async function createReferenceStyleProxyFrames({ targetFrames, treatment, scratchDirectory, executionController, width = 256 }) {
  if (!Array.isArray(targetFrames) || !targetFrames.length) throw new Error("Reference proxy needs target frames");
  if (!Number.isInteger(width) || width < 64 || width > 640) throw new Error("Reference proxy width is invalid");
  const filters = [...buildReferenceStyleTreatmentFilters(treatment.recipe), `scale=${width}:-2`];
  const frames = [];
  for (const [index, frame] of targetFrames.entries()) {
    const imagePath = path.join(scratchDirectory, `reference-proxy-${index}.jpg`);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", frame.imagePath, "-frames:v", "1", "-vf", filters.join(","), "-q:v", "3", imagePath], { executionController });
    const raw = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { executionController, binary: true });
    frames.push(Object.freeze({ timestamp: frame.timestamp, imagePath, metrics: measureReferenceRgbFrame(new Uint8Array(raw)) }));
  }
  return Object.freeze({
    frames: Object.freeze(frames),
    metrics: summarizeReferenceFrameMetrics(frames.map((frame) => frame.metrics)),
    filters: Object.freeze(filters)
  });
}

import { spawn as nodeSpawn } from "child_process";
import {
  MAX_REFERENCE_VIDEO_DURATION_SECONDS,
  MAX_REFERENCE_VIDEO_HEIGHT,
  MAX_REFERENCE_VIDEO_PIXELS,
  MAX_REFERENCE_VIDEO_WIDTH,
  REFERENCE_VIDEO_TYPES,
  isReferenceVideoStyleMatchingEnabled
} from "@/lib/jobs/job-config";
import { EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

export const REFERENCE_VIDEO_PROBE_TIMEOUT_MS = 10_000;
export const REFERENCE_VIDEO_FRAME_DECODE_TIMEOUT_MS = 5_000;
export const REFERENCE_VIDEO_MAX_FRAME_RATE = 120;
export const REFERENCE_VIDEO_DECODE_FRAME_BUDGET = 3;
const FORMAT_FAMILIES = Object.freeze({
  "video/mp4": ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  "video/quicktime": ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  "video/webm": ["matroska", "webm"],
  "video/x-matroska": ["matroska", "webm"]
});

export class ReferenceVideoError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "ReferenceVideoError";
    this.reason = reason;
  }
}

function invalidVideo() {
  return new ReferenceVideoError("REFERENCE_VIDEO_INVALID_MEDIA", "This reference video could not be verified.");
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

/** Owns only the current ffprobe/ffmpeg child through the normal job controller. */
export function runReferenceVideoProcess(command, args, { executionController, spawn = nodeSpawn, timeoutMs } = {}) {
  executionController?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      executionController?.detach(child);
      error ? reject(error) : resolve(result);
    };
    executionController?.attach(child);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(executionController?.isCancelled() ? new EditExecutionCancelledError() : error));
    child.once("close", (code, signal) => {
      if (executionController?.isCancelled()) return finish(new EditExecutionCancelledError());
      if (code === 0) return finish(null, { stdout, stderr });
      return finish(new ReferenceVideoError("REFERENCE_VIDEO_INVALID_MEDIA", stderr.trim() || `${command} exited with ${signal || `code ${code}`}`));
    });
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ReferenceVideoError("REFERENCE_VIDEO_TIMEOUT", "This reference video could not be verified."));
    }, timeoutMs);
  });
}

/**
 * Validates decoded media facts after upload. Browser MIME and filename are only
 * routing hints; ffprobe must find one bounded, decodable visual stream.
 */
export async function probeReferenceVideoFile(inputPath, { executionController, run = runReferenceVideoProcess } = {}) {
  let stdout;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate",
      "-of", "json", inputPath
    ], { executionController, timeoutMs: REFERENCE_VIDEO_PROBE_TIMEOUT_MS }));
  } catch (error) {
    if (error instanceof EditExecutionCancelledError || executionController?.isCancelled()) throw new EditExecutionCancelledError();
    if (error instanceof ReferenceVideoError) throw error;
    throw invalidVideo();
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw invalidVideo();
  }
}

/** Decodes three bounded representative frames; it is validation, not RV-1 analysis. */
export async function decodeReferenceVideoFrames({ inputPath, duration, executionController, run = runReferenceVideoProcess }) {
  const timestamps = Array.from({ length: REFERENCE_VIDEO_DECODE_FRAME_BUDGET }, (_, index) => {
    const fraction = (index + 1) / (REFERENCE_VIDEO_DECODE_FRAME_BUDGET + 1);
    return Number(Math.max(0, Math.min(duration - 0.05, duration * fraction)).toFixed(3));
  });
  try {
    for (const timestamp of timestamps) {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-ss", String(timestamp), "-i", inputPath,
        "-frames:v", "1", "-vf", "scale=320:-2", "-f", "null", "-"
      ], { executionController, timeoutMs: REFERENCE_VIDEO_FRAME_DECODE_TIMEOUT_MS });
    }
  } catch (error) {
    if (error instanceof EditExecutionCancelledError || executionController?.isCancelled()) throw new EditExecutionCancelledError();
    if (error instanceof ReferenceVideoError) throw error;
    throw invalidVideo();
  }
  return Object.freeze(timestamps);
}

/** Returns only server-validated reference facts for future temporal analysis. */
export async function validateReferenceVideoFile({ inputPath, type, executionController, probe = probeReferenceVideoFile, decode = decodeReferenceVideoFrames }) {
  executionController?.throwIfCancelled();
  if (!REFERENCE_VIDEO_TYPES.includes(type)) throw invalidVideo();
  let data;
  try {
    data = await probe(inputPath, { executionController });
  } catch (error) {
    if (error instanceof EditExecutionCancelledError || executionController?.isCancelled()) throw new EditExecutionCancelledError();
    if (error instanceof ReferenceVideoError) throw error;
    throw invalidVideo();
  }
  executionController?.throwIfCancelled();
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const videoStreams = streams.filter((stream) => stream?.codec_type === "video");
  if (videoStreams.length !== 1 || streams.length > 4) throw invalidVideo();
  const stream = videoStreams[0];
  const duration = Number.parseFloat(data?.format?.duration);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const frameRate = parseFrameRate(stream?.avg_frame_rate) || parseFrameRate(stream?.r_frame_rate);
  const formats = String(data?.format?.format_name || "").split(",");
  const allowedFormats = FORMAT_FAMILIES[type] || [];
  if (
    !finitePositive(duration) || duration > MAX_REFERENCE_VIDEO_DURATION_SECONDS ||
    !Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 ||
    longSide > MAX_REFERENCE_VIDEO_WIDTH || shortSide > MAX_REFERENCE_VIDEO_HEIGHT || width * height > MAX_REFERENCE_VIDEO_PIXELS ||
    !finitePositive(frameRate) || frameRate > REFERENCE_VIDEO_MAX_FRAME_RATE ||
    typeof stream?.codec_name !== "string" || !stream.codec_name || !formats.some((format) => allowedFormats.includes(format))
  ) throw invalidVideo();
  const decodedFrameTimestamps = await decode({ inputPath, duration, executionController });
  executionController?.throwIfCancelled();
  return Object.freeze({
    duration,
    width,
    height,
    videoCodec: stream.codec_name,
    frameRate,
    hasAudio: streams.some((entry) => entry?.codec_type === "audio"),
    container: formats.find((format) => allowedFormats.includes(format)),
    decodedFrameTimestamps
  });
}

/**
 * RV-0 records a deterministic future-analysis boundary, but intentionally
 * performs no sampling, shot detection, or model inference yet.
 */
export function createReferenceVideoSamplingPlan(media) {
  const duration = Number(media?.duration);
  const width = Number(media?.width);
  const height = Number(media?.height);
  if (!finitePositive(duration) || duration > MAX_REFERENCE_VIDEO_DURATION_SECONDS || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw invalidVideo();
  }
  const momentCount = Math.max(1, Math.min(6, Math.ceil(duration / 10)));
  const moments = Array.from({ length: momentCount }, (_, index) => {
    const start = Number(((duration * index) / momentCount).toFixed(3));
    const end = Number((duration * (index + 1) / momentCount).toFixed(3));
    return Object.freeze({ momentId: `reference-moment-${index + 1}`, start, end });
  });
  return Object.freeze({
    version: 1,
    media: Object.freeze({ duration, width, height }),
    maxRepresentativeFramesPerMoment: 3,
    moments: Object.freeze(moments)
  });
}

/** RV-0 never turns the flag into matching capability; it only admits bounded foundation uploads. */
export function assertReferenceVideoFoundationEnabled(environment = process.env) {
  if (!isReferenceVideoStyleMatchingEnabled(environment)) {
    throw new ReferenceVideoError("REFERENCE_VIDEO_DISABLED", "Video style references are not available yet.");
  }
}

export function assertReferenceVideoMatchingImplemented() {
  throw new ReferenceVideoError("REFERENCE_VIDEO_MATCHING_NOT_IMPLEMENTED", "Video style references are not available yet.");
}

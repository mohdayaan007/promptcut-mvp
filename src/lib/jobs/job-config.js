import { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS } from "@/lib/media/media-config";

export const MAX_DIRECT_UPLOAD_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_JOB_BYTES = 25 * 1024 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
export const REFERENCE_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
// Reference videos are analysis-only assets. These deliberately small limits
// bound private-storage retention, download time, and future temporal analysis.
export const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;
export const MAX_REFERENCE_VIDEO_DURATION_SECONDS = 60;
export const MAX_REFERENCE_VIDEO_WIDTH = 3840;
export const MAX_REFERENCE_VIDEO_HEIGHT = 2160;
export const MAX_REFERENCE_VIDEO_PIXELS = MAX_REFERENCE_VIDEO_WIDTH * MAX_REFERENCE_VIDEO_HEIGHT;
export const REFERENCE_VIDEO_TYPES = Object.freeze(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);
export const REFERENCE_VIDEO_CAPABILITY_ENV = "REFERENCE_VIDEO_STYLE_MATCHING_ENABLED";
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const UPLOAD_URL_BATCH_SIZE = 8;
export const JOB_STATUSES = ["uploading", "queued", "analyzing", "rendering", "completed", "failed", "cancelled"];

export function jobConfig() {
  return {
    workerConcurrency: Number(process.env.JOB_WORKER_CONCURRENCY || 1),
    maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS || 2),
    sourceRetentionHours: Number(process.env.JOB_SOURCE_RETENTION_HOURS || 24),
    outputRetentionHours: Number(process.env.JOB_OUTPUT_RETENTION_HOURS || 168),
    scratchDirectory: process.env.JOB_SCRATCH_DIRECTORY || "/tmp/cliponaut-jobs",
    pollIntervalMs: Number(process.env.JOB_POLL_INTERVAL_MS || 2_000),
    staleAfterMs: Number(process.env.JOB_STALE_AFTER_MS || 15 * 60 * 1_000)
  };
}

export function validateUploadManifest(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("Upload at least one video");
  if (files.length > MAX_VIDEO_COUNT) throw new Error(`Upload up to ${MAX_VIDEO_COUNT} videos at a time`);
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file.name !== "string" || typeof file.type !== "string" || !Number.isSafeInteger(file.size)) {
      throw new Error("Each upload must include valid file metadata");
    }
    if (!file.type.startsWith("video/")) throw new Error("Uploaded files must be videos");
    if (file.size <= 0 || file.size > MAX_DIRECT_UPLOAD_FILE_BYTES) throw new Error("Each video must be 5 GB or smaller");
    totalBytes += file.size;
  }
  if (totalBytes > MAX_DIRECT_UPLOAD_JOB_BYTES) throw new Error("The combined upload must be 25 GB or smaller");
  return totalBytes;
}

/** A reference is deliberately not an edit source: it has its own bounded contract. */
export function isReferenceVideoStyleMatchingEnabled(environment = process.env) {
  return environment?.[REFERENCE_VIDEO_CAPABILITY_ENV] === "true";
}

export function validateReferenceManifest(reference, { videoReferenceEnabled = isReferenceVideoStyleMatchingEnabled() } = {}) {
  if (reference == null) return null;
  if (!reference || typeof reference.name !== "string" || typeof reference.type !== "string" || !Number.isSafeInteger(reference.size)) {
    throw new Error("The style reference must include valid metadata");
  }
  // Existing image callers omitted kind. Video is new and must be explicit so
  // an attachment cannot become analysis media simply because of a MIME hint.
  if (reference.kind === undefined && reference.type.startsWith("video/")) {
    throw new Error('Video style references must include kind: "video"');
  }
  const kind = reference.kind ?? (reference.type.startsWith("image/") ? "image" : null);
  if (!Object.freeze(["image", "video"]).includes(kind)) throw new Error("The style reference type is not supported");
  if (kind === "image") {
    if (!reference.type.startsWith("image/")) throw new Error("The style reference kind and media type do not match");
    if (!REFERENCE_IMAGE_TYPES.includes(reference.type)) throw new Error("Style reference images must be JPG, PNG, or WebP");
    if (reference.size <= 0 || reference.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error("The style reference image must be 25 MB or smaller");
    return { kind, name: reference.name, type: reference.type, size: reference.size };
  }
  if (!reference.type.startsWith("video/")) throw new Error("The style reference kind and media type do not match");
  if (!videoReferenceEnabled) throw new Error("Video style references are not available yet");
  if (!REFERENCE_VIDEO_TYPES.includes(reference.type)) throw new Error("Style reference videos must be MP4, MOV, WebM, or MKV");
  if (reference.size <= 0 || reference.size > MAX_REFERENCE_VIDEO_BYTES) throw new Error("The style reference video must be 250 MB or smaller");
  return { kind, name: reference.name, type: reference.type, size: reference.size };
}

export function validateJobRequest({ prompt, exportQuality, sources }) {
  if (typeof prompt !== "string" || prompt.trim().length > 1000) throw new Error("prompt must be 1000 characters or fewer");
  if (!prompt.trim()) throw new Error("Describe the edit you want to make");
  if (!sources?.length || sources.length > MAX_VIDEO_COUNT) throw new Error("Upload between one and five videos");
  if (!["standard", "4k"].includes(exportQuality || "standard")) throw new Error("exportQuality must be standard or 4k");
}

export { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS };

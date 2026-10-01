import { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS } from "@/lib/media/media-config";

export const MAX_DIRECT_UPLOAD_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_JOB_BYTES = 25 * 1024 * 1024 * 1024;
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

export function validateJobRequest({ prompt, exportQuality, sources }) {
  if (typeof prompt !== "string" || prompt.trim().length > 1000) throw new Error("prompt must be 1000 characters or fewer");
  if (!prompt.trim()) throw new Error("Describe the edit you want to make");
  if (!sources?.length || sources.length > MAX_VIDEO_COUNT) throw new Error("Upload between one and five videos");
  if (!["standard", "4k"].includes(exportQuality || "standard")) throw new Error("exportQuality must be standard or 4k");
}

export { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS };

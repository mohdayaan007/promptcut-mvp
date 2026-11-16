import { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS } from "@/lib/media/media-config";

export const MAX_DIRECT_UPLOAD_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_JOB_BYTES = 25 * 1024 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
export const REFERENCE_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
// Reference video is deliberately much smaller and shorter than an edit
// source: it is sampled for style evidence only and must never become a
// timeline source.
export const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;
export const MAX_REFERENCE_VIDEO_DURATION_SECONDS = 60;
export const MAX_REFERENCE_VIDEO_DIMENSION = 1920;
export const MAX_REFERENCE_VIDEO_PIXELS = 1920 * 1080;
export const REFERENCE_VIDEO_TYPES = Object.freeze(["video/mp4", "video/quicktime", "video/webm"]);
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const UPLOAD_URL_BATCH_SIZE = 8;
export const JOB_STATUSES = ["uploading", "queued", "analyzing", "rendering", "completed", "failed", "cancelled"];
export const REFERENCE_PROFILE_MAX_BYTES = 4096;

export function validateReferenceColourProfile(profile) {
  if (profile == null) return null;
  if (Buffer.byteLength(JSON.stringify(profile), "utf8") > REFERENCE_PROFILE_MAX_BYTES || profile.version !== 1 || profile.colorSpace !== "srgb-rgb24-canvas" || profile.width !== 640 || profile.height !== 360 || !Number.isInteger(profile.sampleCount) || profile.sampleCount !== 640 * 360 * 5 || !Array.isArray(profile.mean) || profile.mean.length !== 3 || !Array.isArray(profile.covariance) || profile.covariance.length !== 3 || !profile.covariance.every((row) => Array.isArray(row) && row.length === 3)) throw new Error("Reference colour profile is invalid");
  const values = [...profile.mean, ...profile.covariance.flat()];
  if (!values.every(Number.isFinite) || profile.mean.some((value) => value < 0 || value > 255) || profile.covariance.some((row, i) => row.some((value, j) => Math.abs(value - profile.covariance[j][i]) > 1e-6))) throw new Error("Reference colour profile is invalid");
  const a=profile.covariance; const minors=[a[0][0],a[1][1],a[2][2],a[0][0]*a[1][1]-a[0][1]**2,a[0][0]*a[2][2]-a[0][2]**2,a[1][1]*a[2][2]-a[1][2]**2,a[0][0]*(a[1][1]*a[2][2]-a[1][2]**2)-a[0][1]*(a[0][1]*a[2][2]-a[1][2]*a[0][2])+a[0][2]*(a[0][1]*a[1][2]-a[1][1]*a[0][2])];
  if (minors.some((value) => value < -1e-5)) throw new Error("Reference colour profile covariance is invalid");
  return Object.freeze({ kind: "video_profile", profile: { version: 1, colorSpace: profile.colorSpace, width: profile.width, height: profile.height, sampleCount: profile.sampleCount, mean: [...profile.mean], covariance: profile.covariance.map((row) => [...row]) } });
}

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
export function validateReferenceManifest(reference) {
  if (reference == null) return null;
  if (!reference || typeof reference.name !== "string" || typeof reference.type !== "string" || !Number.isSafeInteger(reference.size)) {
    throw new Error("The style reference must include valid media metadata");
  }
  if (REFERENCE_IMAGE_TYPES.includes(reference.type)) {
    if (reference.size <= 0 || reference.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error("The style reference image must be 25 MB or smaller");
    return { kind: "image", name: reference.name, type: reference.type, size: reference.size };
  }
  if (REFERENCE_VIDEO_TYPES.includes(reference.type)) {
    if (reference.size <= 0 || reference.size > MAX_REFERENCE_VIDEO_BYTES) throw new Error("The style reference video must be 250 MB or smaller");
    return { kind: "video", name: reference.name, type: reference.type, size: reference.size };
  }
  throw new Error("Style references must be JPG, PNG, WebP, MP4, MOV, or WebM files");
}

/**
 * Customer reference videos are intentionally fail-closed until a trusted,
 * server-owned safety service can attach dedicated evidence. A MIME type,
 * video probe, or generic nude/minor classification is not that evidence.
 */
export function assertCustomerReferenceVideoUploadAllowed(reference) {
  if (reference?.kind === "video") {
    throw new Error("Reference-video uploads are not available yet because dedicated safety screening is not configured");
  }
}

export function validateJobRequest({ prompt, exportQuality, sources }) {
  if (typeof prompt !== "string" || prompt.trim().length > 1000) throw new Error("prompt must be 1000 characters or fewer");
  if (!prompt.trim()) throw new Error("Describe the edit you want to make");
  if (!sources?.length || sources.length > MAX_VIDEO_COUNT) throw new Error("Upload between one and five videos");
  if (!["standard", "4k"].includes(exportQuality || "standard")) throw new Error("exportQuality must be standard or 4k");
}

export { MAX_VIDEO_COUNT, MAX_VIDEO_DURATION_SECONDS };

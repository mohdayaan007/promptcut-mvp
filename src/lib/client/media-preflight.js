import { MAX_INPUT_DIMENSION, MAX_INPUT_PIXELS, MAX_VIDEO_DURATION_SECONDS } from "@/lib/media/media-config";

/**
 * Fast browser-side feedback only. The worker still probes the stored source
 * authoritatively before rendering because browser metadata is not trusted.
 */
export function browserVideoPreflightError(metadata) {
  const duration = Number(metadata?.duration);
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    return "The uploaded file must contain a readable video stream";
  }
  if (duration > MAX_VIDEO_DURATION_SECONDS) return "Each video must be 10 minutes or shorter";
  if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION || width * height > MAX_INPUT_PIXELS) {
    return "The uploaded video resolution is not supported";
  }
  return null;
}

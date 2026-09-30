export const MAX_VIDEO_COUNT = 5;
export const MAX_VIDEO_FILE_SIZE_BYTES = 250 * 1024 * 1024;
export const MAX_REQUEST_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEO_DURATION_SECONDS = 10 * 60;
export const MAX_INPUT_DIMENSION = 3840;
export const MAX_INPUT_PIXELS = 3840 * 2160;
export const EXPORT_QUALITIES = ["standard", "4k"];
export const STANDARD_MAX_LONG_SIDE = 1920;

export function is4kCapableMedia({ width, height }) {
  return Math.min(width, height) >= 2160 && Math.max(width, height) >= 3840;
}

export function isSupportedExportQuality(value) {
  return EXPORT_QUALITIES.includes(value);
}

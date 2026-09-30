import { STANDARD_MAX_LONG_SIDE } from "@/lib/media/media-config";

const ASPECT_RATIOS = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1
};

function toEven(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * A job uses one base canvas so concat remains deterministic. Standard caps the
 * primary source at 1080p-class output; 4K keeps a 4K-class primary canvas.
 * The normalizer never enlarges an individual source to fill that canvas.
 */
export function createMediaProfile({ media, exportQuality }) {
  const primary = media[0];
  const primaryLandscape = primary.width >= primary.height;
  const primaryRatio = primary.width / primary.height;
  const primaryLongSide = Math.max(primary.width, primary.height);
  const targetLongSide = exportQuality === "4k" ? 3840 : Math.min(STANDARD_MAX_LONG_SIDE, primaryLongSide);

  const width = primaryLandscape ? targetLongSide : toEven(targetLongSide * primaryRatio);
  const height = primaryLandscape ? toEven(targetLongSide / primaryRatio) : targetLongSide;

  return { width: toEven(width), height: toEven(height), exportQuality };
}

export function getCropSettings(operation, profile) {
  if (!operation) return { width: profile.width, height: profile.height, filter: null };

  const targetRatio = ASPECT_RATIOS[operation.aspect_ratio];
  const currentRatio = profile.width / profile.height;
  let width;
  let height;

  if (currentRatio > targetRatio) {
    height = profile.height;
    width = toEven(height * targetRatio);
  } else {
    width = profile.width;
    height = toEven(width / targetRatio);
  }

  return {
    width,
    height,
    filter: `crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2`
  };
}

export function buildNormalizationFilter(profile) {
  const width = profile.width;
  const height = profile.height;
  return `scale=w='min(iw\\,${width})':h='min(ih\\,${height})':force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
}

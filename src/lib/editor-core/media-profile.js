import { STANDARD_MAX_LONG_SIDE } from "@/lib/media/media-config";

const ASPECT_RATIOS = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1
};

function toEven(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function isLandscape({ width, height }) {
  return width >= height;
}

function maximumCoveredLongSide(source, targetRatio) {
  if (targetRatio >= 1) return Math.min(source.width, source.height * targetRatio);
  return Math.min(source.height, source.width / targetRatio);
}

/**
 * A job uses one base canvas so concat remains deterministic. Compatible source
 * clips constrain the canvas to a size they can cover without being enlarged.
 * Clips with a radically different orientation are fitted with padding unless
 * the user explicitly requests an aspect-ratio crop.
 */
export function createMediaProfile({ media, exportQuality, aspectRatio }) {
  const primary = media[0];
  const targetRatio = aspectRatio ? ASPECT_RATIOS[aspectRatio] : primary.width / primary.height;
  const hasExplicitAspect = Boolean(aspectRatio);
  const targetLandscape = targetRatio >= 1;
  const compatibleSources = hasExplicitAspect
    ? media
    : media.filter((source) => isLandscape(source) === isLandscape(primary));
  const maximumSourceLongSide = Math.min(
    ...compatibleSources.map((source) => maximumCoveredLongSide(source, targetRatio))
  );
  const exportLongSide = exportQuality === "4k" ? 3840 : STANDARD_MAX_LONG_SIDE;
  const targetLongSide = Math.min(exportLongSide, maximumSourceLongSide);

  const width = targetLandscape ? targetLongSide : toEven(targetLongSide * targetRatio);
  const height = targetLandscape ? toEven(targetLongSide / targetRatio) : targetLongSide;

  return {
    width: toEven(width),
    height: toEven(height),
    exportQuality,
    targetRatio,
    hasExplicitAspect
  };
}

export function getCropSettings(operation, profile) {
  if (!operation) return { width: profile.width, height: profile.height, filter: null };
  if (profile.hasExplicitAspect) {
    return { width: profile.width, height: profile.height, filter: null };
  }

  const targetRatio = ASPECT_RATIOS[operation.aspect_ratio];
  const currentRatio = profile.width / profile.height;
  if (Math.abs(currentRatio - targetRatio) < 0.001) {
    return { width: profile.width, height: profile.height, filter: null };
  }
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

export function buildNormalizationFilter(profile, source) {
  const width = profile.width;
  const height = profile.height;
  const sourceMatchesCanvasOrientation = isLandscape(source) === isLandscape(profile);
  if (profile.hasExplicitAspect || sourceMatchesCanvasOrientation) {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p,setsar=1`;
  }

  return `scale=w='min(iw\\,${width})':h='min(ih\\,${height})':force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
}

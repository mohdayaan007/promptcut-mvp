// B2 frame metrics are deterministic measurements over decoded RGB24 frames.
// They are intentionally server-owned: Gemini may describe a reference, but it
// never invents pixel headroom, percentile, or saturation values.
export const REFERENCE_FRAME_METRICS_VERSION = 1;

function metricsError(message) {
  return new Error(`Invalid reference frame metrics: ${message}`);
}

function quantileFromHistogram(histogram, pixelCount, percentile) {
  // Nearest-rank quantiles make results deterministic without retaining every
  // pixel. p05/p50/p95 are normalized luma values in the closed 0..1 range.
  const rank = Math.max(0, Math.ceil(percentile * pixelCount) - 1);
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen > rank) return value / 255;
  }
  return 1;
}

/** Measures one RGB24 frame in O(pixel count) time and constant extra memory. */
export function measureReferenceRgbFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length % 3 !== 0) {
    throw metricsError("frame must be a non-empty RGB24 byte array");
  }

  const lumaHistogram = new Uint32Array(256);
  let nearBlackPixels = 0;
  let nearWhitePixels = 0;
  let saturationTotal = 0;
  const pixelCount = frame.length / 3;

  for (let index = 0; index < frame.length; index += 3) {
    const red = frame[index];
    const green = frame[index + 1];
    const blue = frame[index + 2];
    const lumaByte = Math.round((0.2126 * red) + (0.7152 * green) + (0.0722 * blue));
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    lumaHistogram[lumaByte] += 1;
    if (lumaByte <= 8) nearBlackPixels += 1;
    if (lumaByte >= 247) nearWhitePixels += 1;
    saturationTotal += maximum === 0 ? 0 : (maximum - minimum) / maximum;
  }

  return Object.freeze({
    version: REFERENCE_FRAME_METRICS_VERSION,
    lumaP05: quantileFromHistogram(lumaHistogram, pixelCount, 0.05),
    lumaP50: quantileFromHistogram(lumaHistogram, pixelCount, 0.5),
    lumaP95: quantileFromHistogram(lumaHistogram, pixelCount, 0.95),
    nearBlackFraction: nearBlackPixels / pixelCount,
    nearWhiteFraction: nearWhitePixels / pixelCount,
    saturationIndex: saturationTotal / pixelCount
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Summarizes representative frame measurements without retaining image data. */
export function summarizeReferenceFrameMetrics(measurements) {
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw metricsError("measurements must be a non-empty array");
  }
  const fields = ["lumaP05", "lumaP50", "lumaP95", "nearBlackFraction", "nearWhiteFraction", "saturationIndex"];
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== "object") throw metricsError("measurement must be an object");
    for (const field of fields) {
      if (!Number.isFinite(measurement[field]) || measurement[field] < 0 || measurement[field] > 1) {
        throw metricsError(`${field} must be a finite number between 0 and 1`);
      }
    }
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, median(measurements.map((measurement) => measurement[field]))])));
}

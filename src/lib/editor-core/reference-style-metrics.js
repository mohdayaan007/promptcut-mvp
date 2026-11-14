// B2 frame metrics are deterministic measurements over decoded RGB24 frames.
// They are intentionally server-owned: Gemini may describe a reference, but it
// never invents pixel headroom, percentile, or saturation values.
export const REFERENCE_FRAME_METRICS_VERSION = 2;

function metricsError(message) {
  return new Error(`Invalid reference frame metrics: ${message}`);
}

function quantileFromHistogram(histogram, pixelCount, percentile) {
  // Nearest-rank quantiles make results deterministic without retaining every
  // pixel. The luma percentiles are normalized values in the closed 0..1 range.
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
  const redHistogram = new Uint32Array(256);
  const greenHistogram = new Uint32Array(256);
  const blueHistogram = new Uint32Array(256);
  let nearBlackPixels = 0;
  let nearWhitePixels = 0;
  let saturationTotal = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  const bands = [{ count: 0, red: 0, blue: 0 }, { count: 0, red: 0, blue: 0 }, { count: 0, red: 0, blue: 0 }];
  const pixelCount = frame.length / 3;

  for (let index = 0; index < frame.length; index += 3) {
    const red = frame[index];
    const green = frame[index + 1];
    const blue = frame[index + 2];
    redTotal += red; greenTotal += green; blueTotal += blue;
    const lumaByte = Math.round((0.2126 * red) + (0.7152 * green) + (0.0722 * blue));
    const band = bands[lumaByte <= 64 ? 0 : lumaByte <= 191 ? 1 : 2];
    band.count += 1; band.red += red; band.blue += blue;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    lumaHistogram[lumaByte] += 1;
    redHistogram[red] += 1; greenHistogram[green] += 1; blueHistogram[blue] += 1;
    if (lumaByte <= 8) nearBlackPixels += 1;
    if (lumaByte >= 247) nearWhitePixels += 1;
    saturationTotal += maximum === 0 ? 0 : (maximum - minimum) / maximum;
  }

  return Object.freeze({
    version: REFERENCE_FRAME_METRICS_VERSION,
    lumaP05: quantileFromHistogram(lumaHistogram, pixelCount, 0.05),
    lumaP50: quantileFromHistogram(lumaHistogram, pixelCount, 0.5),
    lumaP95: quantileFromHistogram(lumaHistogram, pixelCount, 0.95),
    // p99 detects small, bright skin/practical-light areas that p95 can miss.
    // It lets B2 constrain only highlight-risky axes without weakening the
    // broader treatment for an otherwise safe target.
    lumaP99: quantileFromHistogram(lumaHistogram, pixelCount, 0.99),
    redP05: quantileFromHistogram(redHistogram, pixelCount, 0.05),
    redP50: quantileFromHistogram(redHistogram, pixelCount, 0.5),
    redP95: quantileFromHistogram(redHistogram, pixelCount, 0.95),
    greenP05: quantileFromHistogram(greenHistogram, pixelCount, 0.05),
    greenP50: quantileFromHistogram(greenHistogram, pixelCount, 0.5),
    greenP95: quantileFromHistogram(greenHistogram, pixelCount, 0.95),
    blueP05: quantileFromHistogram(blueHistogram, pixelCount, 0.05),
    blueP50: quantileFromHistogram(blueHistogram, pixelCount, 0.5),
    blueP95: quantileFromHistogram(blueHistogram, pixelCount, 0.95),
    nearBlackFraction: nearBlackPixels / pixelCount,
    nearWhiteFraction: nearWhitePixels / pixelCount,
    saturationIndex: saturationTotal / pixelCount,
    redMean: redTotal / pixelCount / 255,
    greenMean: greenTotal / pixelCount / 255,
    blueMean: blueTotal / pixelCount / 255,
    shadowWarmth: bands[0].count ? (bands[0].red - bands[0].blue) / bands[0].count / 255 : 0,
    midtoneWarmth: bands[1].count ? (bands[1].red - bands[1].blue) / bands[1].count / 255 : 0,
    highlightWarmth: bands[2].count ? (bands[2].red - bands[2].blue) / bands[2].count / 255 : 0
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
  const fields = ["lumaP05", "lumaP50", "lumaP95", "lumaP99", "redP05", "redP50", "redP95", "greenP05", "greenP50", "greenP95", "blueP05", "blueP50", "blueP95", "nearBlackFraction", "nearWhiteFraction", "saturationIndex", "redMean", "greenMean", "blueMean", "shadowWarmth", "midtoneWarmth", "highlightWarmth"];
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== "object") throw metricsError("measurement must be an object");
    for (const field of fields) {
      if (!Number.isFinite(measurement[field]) || measurement[field] < (field.endsWith("Warmth") ? -1 : 0) || measurement[field] > 1) {
        throw metricsError(`${field} must be a finite number between 0 and 1`);
      }
    }
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, median(measurements.map((measurement) => measurement[field]))])));
}

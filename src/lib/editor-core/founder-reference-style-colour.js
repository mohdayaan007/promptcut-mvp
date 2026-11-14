import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";

const bounded = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const needed = ["lumaP05", "lumaP50", "lumaP95", "lumaP99", "redP05", "redP50", "redP95", "greenP05", "greenP50", "greenP95", "blueP05", "blueP50", "blueP95", "nearBlackFraction", "nearWhiteFraction", "saturationIndex", "redMean", "greenMean", "blueMean", "shadowWarmth", "midtoneWarmth", "highlightWarmth"];

function metrics(value, label) {
  if (!value || typeof value !== "object" || needed.some((key) => !Number.isFinite(value[key]) || value[key] < (key.endsWith("Warmth") ? -1 : 0) || value[key] > 1)) {
    throw new Error(`Founder reference colour evidence is invalid: ${label}`);
  }
  return value;
}

function level(value, low, high) { return value < low ? "low" : value > high ? "high" : "medium"; }
function warmth(value) { return value > 0.025 ? "warm" : value < -0.025 ? "cool" : "neutral"; }
function channelCurve(reference, source, channel) {
  const percentiles = ["P05", "P50", "P95"];
  const rawInputs = percentiles.map((percentile) => bounded(source[`${channel}${percentile}`], 0.04, 0.96));
  const inputs = rawInputs[1] - rawInputs[0] >= 0.035 && rawInputs[2] - rawInputs[1] >= 0.035 ? rawInputs : [0.15, 0.5, 0.85];
  let previousOutput = 0;
  return percentiles.map((percentile, index) => {
    const input = inputs[index];
    const intended = reference[`${channel}${percentile}`];
    const output = bounded(Math.max(previousOutput, intended), Math.max(0, input - 0.28), Math.min(1, input + 0.28));
    previousOutput = output;
    return { input, output };
  });
}

/**
 * Transfers server-measured reference colour intent into the existing bounded
 * renderer controls. Deliberate colour casts and black/highlight character
 * retain authority; limits prevent broken channels and non-monotonic curves.
 */
export function deriveFounderReferenceColourTreatment({ referenceMetrics, sourceMetrics }) {
  const reference = metrics(referenceMetrics, "reference metrics");
  const source = metrics(sourceMetrics, "source metrics");
  const referenceRange = reference.lumaP95 - reference.lumaP05;
  const sourceRange = source.lumaP95 - source.lumaP05;
  const referenceWarmth = reference.redMean - reference.blueMean;
  const sourceWarmth = source.redMean - source.blueMean;
  const referenceGreen = reference.greenMean - ((reference.redMean + reference.blueMean) / 2);
  const sourceGreen = source.greenMean - ((source.redMean + source.blueMean) / 2);
  const recipe = {
    brightness: bounded((reference.lumaP50 - source.lumaP50) * 0.85, -0.18, 0.18),
    contrast: bounded((referenceRange - sourceRange) * 0.9, -0.32, 0.32),
    saturation: bounded((reference.saturationIndex - source.saturationIndex) * 0.85, -0.35, 0.35),
    temperature: bounded((referenceWarmth - sourceWarmth) * 0.95, -0.35, 0.35),
    tint: bounded((referenceGreen - sourceGreen) * 0.7, -0.18, 0.18),
    shadows: bounded((reference.lumaP05 - source.lumaP05) * 0.55, -0.2, 0.2),
    highlights: bounded((reference.lumaP95 - source.lumaP95) * 0.55, -0.18, 0.18),
    vibrance: bounded((reference.saturationIndex - source.saturationIndex) * 0.5, -0.18, 0.18),
    blackLift: bounded((source.nearBlackFraction - reference.nearBlackFraction) * 0.8, -0.35, 0.35),
    midtoneGamma: bounded((reference.lumaP50 - source.lumaP50) * 0.7, -0.3, 0.3),
    shadowTemperature: bounded((reference.shadowWarmth - source.shadowWarmth) * 1.1, -0.35, 0.35),
    midtoneTemperature: bounded((reference.midtoneWarmth - source.midtoneWarmth) * 1.1, -0.35, 0.35),
    highlightTemperature: bounded((reference.highlightWarmth - source.highlightWarmth) * 1.1, -0.35, 0.35)
  };
  return createCanonicalReferenceStyleTreatment({ version: 2, recipe: { ...recipe, channelCurves: { red: channelCurve(reference, source, "red"), green: channelCurve(reference, source, "green"), blue: channelCurve(reference, source, "blue") } } });
}

export function deriveFounderReferenceColourObservation(referenceMetrics) {
  const reference = metrics(referenceMetrics, "reference metrics");
  return Object.freeze({
    warmth: warmth(reference.redMean - reference.blueMean),
    saturation: level(reference.saturationIndex, 0.24, 0.46),
    contrast: level(reference.lumaP95 - reference.lumaP05, 0.42, 0.66)
  });
}

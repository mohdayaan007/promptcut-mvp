import { createCanonicalReferenceStyleTreatment } from "@/lib/editor-core/reference-style-treatment";

const bounded = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const needed = ["lumaP05", "lumaP50", "lumaP95", "lumaP99", "nearBlackFraction", "nearWhiteFraction", "saturationIndex", "redMean", "greenMean", "blueMean"];

function metrics(value, label) {
  if (!value || typeof value !== "object" || needed.some((key) => !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) {
    throw new Error(`Founder reference colour evidence is invalid: ${label}`);
  }
  return value;
}

function level(value, low, high) { return value < low ? "low" : value > high ? "high" : "medium"; }
function warmth(value) { return value > 0.025 ? "warm" : value < -0.025 ? "cool" : "neutral"; }

/**
 * Maps only server-measured, aggregate RGB statistics into the existing
 * canonical grading envelope. It deliberately does not claim scene matching,
 * skin selection, LUT recovery, or reference typography inference.
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
    brightness: bounded((reference.lumaP50 - source.lumaP50) * 0.32, -0.045, 0.045),
    contrast: bounded((referenceRange - sourceRange) * 0.22, -0.055, 0.055),
    saturation: bounded((reference.saturationIndex - source.saturationIndex) * 0.22, -0.07, 0.07),
    temperature: bounded((referenceWarmth - sourceWarmth) * 0.22, -0.065, 0.065),
    tint: bounded((referenceGreen - sourceGreen) * 0.16, -0.035, 0.035),
    shadows: bounded((reference.lumaP05 - source.lumaP05) * 0.16, -0.04, 0.04),
    highlights: bounded((reference.lumaP95 - source.lumaP95) * 0.13, -0.035, 0.035),
    vibrance: bounded((reference.saturationIndex - source.saturationIndex) * 0.12, -0.04, 0.04),
    shadowTemperature: 0,
    midtoneTemperature: bounded((referenceWarmth - sourceWarmth) * 0.1, -0.025, 0.025),
    highlightTemperature: 0
  };
  return createCanonicalReferenceStyleTreatment({ version: 2, recipe });
}

export function deriveFounderReferenceColourObservation(referenceMetrics) {
  const reference = metrics(referenceMetrics, "reference metrics");
  return Object.freeze({
    warmth: warmth(reference.redMean - reference.blueMean),
    saturation: level(reference.saturationIndex, 0.24, 0.46),
    contrast: level(reference.lumaP95 - reference.lumaP05, 0.42, 0.66)
  });
}

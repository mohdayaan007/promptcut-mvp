import test from "node:test";
import assert from "node:assert/strict";
import { deriveFounderReferenceColourTreatment } from "../src/lib/editor-core/founder-reference-style-colour.js";
import { createFounderStyleProfileFromColourEvidence } from "../src/lib/editor-core/founder-reference-style-staging-contract.js";
import { buildReferenceStyleTreatmentFilters } from "../src/lib/editor-core/edit-executor.js";

const source = Object.freeze({ lumaP05: 0.12, lumaP50: 0.58, lumaP95: 0.9, lumaP99: 0.96, redP05: 0.15, redP50: 0.51, redP95: 0.9, greenP05: 0.14, greenP50: 0.55, greenP95: 0.91, blueP05: 0.13, blueP50: 0.48, blueP95: 0.85, nearBlackFraction: 0.02, nearWhiteFraction: 0.01, saturationIndex: 0.42, redMean: 0.51, greenMean: 0.55, blueMean: 0.48, shadowWarmth: 0.02, midtoneWarmth: 0.03, highlightWarmth: 0.01 });
const cool = Object.freeze({ ...source, lumaP50: 0.46, saturationIndex: 0.23, redP50: 0.38, greenP50: 0.48, blueP50: 0.57, redMean: 0.38, greenMean: 0.48, blueMean: 0.57, shadowWarmth: -0.2, midtoneWarmth: -0.16, highlightWarmth: -0.08 });
const warm = Object.freeze({ ...source, lumaP50: 0.66, saturationIndex: 0.6, redP50: 0.63, greenP50: 0.54, blueP50: 0.39, redMean: 0.63, greenMean: 0.54, blueMean: 0.39, shadowWarmth: 0.22, midtoneWarmth: 0.19, highlightWarmth: 0.1 });
const reference = Object.freeze({ id: "founder-rve1-moved-to-blore", key: "founder-reference-style/v1/reference-rve1.mp4", type: "video/mp4", sha256: "a".repeat(64), size: 1024, duration: 12, width: 1280, height: 720, hasAudio: true });

test("local reference metrics generate bounded and visibly distinct canonical treatments", () => {
  const coolTreatment = deriveFounderReferenceColourTreatment({ referenceMetrics: cool, sourceMetrics: source });
  const warmTreatment = deriveFounderReferenceColourTreatment({ referenceMetrics: warm, sourceMetrics: source });
  assert.ok(coolTreatment.recipe.temperature < 0);
  assert.ok(warmTreatment.recipe.temperature > 0);
  assert.ok(coolTreatment.recipe.saturation < 0);
  assert.ok(warmTreatment.recipe.saturation > 0);
  assert.ok(coolTreatment.recipe.midtoneTemperature < 0);
  assert.ok(warmTreatment.recipe.midtoneTemperature > 0);
  assert.notDeepEqual(coolTreatment.recipe.channelCurves, warmTreatment.recipe.channelCurves);
  assert.ok(buildReferenceStyleTreatmentFilters(coolTreatment.recipe).some((filter) => filter.startsWith("curves=r=")));
  for (const treatment of [coolTreatment, warmTreatment]) for (const [field, value] of Object.entries(treatment.recipe)) if (field !== "channelCurves") assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
});

test("local colour profiles remain reference-bound and reject incomplete evidence", () => {
  const profile = createFounderStyleProfileFromColourEvidence({ referenceAsset: reference, sourceMetrics: source, referenceMetrics: cool });
  assert.equal(profile.referenceSha256, reference.sha256);
  assert.equal(profile.observation.typography, "none");
  assert.throws(() => deriveFounderReferenceColourTreatment({ referenceMetrics: { ...cool, redMean: NaN }, sourceMetrics: source }), /invalid/);
});

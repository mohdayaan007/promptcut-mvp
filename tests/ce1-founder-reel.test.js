import test from "node:test";
import assert from "node:assert/strict";
import { CE1_OUTPUT_DURATION, CE1_PRODUCT_GRAPHIC, CE1_SOURCE_ID, CE1_VISUAL_ADJUSTMENT, createCe1FounderReelPlan, createCe1KineticAssDocument, validateCe1FounderReelPlan } from "../src/lib/editor-core/ce1-founder-reel.js";

const sources = [{ sourceId: CE1_SOURCE_ID, duration: 117.098089, width: 1280, height: 720, hasAudio: true }];

test("CE-1 seals a transcript-backed three-beat V2 edit", () => {
  const result = validateCe1FounderReelPlan(createCe1FounderReelPlan(), sources);
  assert.ok(Math.abs(result.duration - CE1_OUTPUT_DURATION) < 0.001);
  assert.deepEqual(result.plan.operations[0].clips, [
    { sourceId: CE1_SOURCE_ID, start: 0.8, end: 3.2 },
    { sourceId: CE1_SOURCE_ID, start: 20.8, end: 26.2 },
    { sourceId: CE1_SOURCE_ID, start: 73.6, end: 77.7 }
  ]);
});

test("CE-1 refuses an altered cut or insufficient media evidence", () => {
  const plan = createCe1FounderReelPlan();
  plan.operations[0].clips[1].start = 20.7;
  assert.throws(() => validateCe1FounderReelPlan(plan, sources), /differs from transcript-backed/);
  assert.throws(() => validateCe1FounderReelPlan(createCe1FounderReelPlan(), [{ ...sources[0], duration: 70 }]), /does not cover/);
});

test("CE-1 kinetic composition contains only fixed libass layers", () => {
  const document = createCe1KineticAssDocument();
  assert.match(document, /MOHAMMED/);
  assert.match(document, /AYAAN/);
  assert.match(document, /HEY, A16Z/);
  assert.match(document, /ChatGPT/);
  assert.match(document, /\\move\(/);
  assert.match(document, /\\p1/);
  assert.doesNotMatch(document, /https?:|<script|javascript:/i);
});

test("CE-1 V3 preserves the documented exposure correction and verified product graphic", () => {
  assert.deepEqual(CE1_VISUAL_ADJUSTMENT, {
    brightness: 0,
    contrast: 0.035,
    saturation: -0.02,
    temperature: -0.035,
    tint: 0.005
  });
  assert.deepEqual(CE1_PRODUCT_GRAPHIC, {
    assetId: "cliponaut-wordmark",
    relativePath: "public/cliponaut.svg",
    sha256: "412b674fbc5b29cd3e84f51f56b2f3b9c3a4eda31978f5dd558dc0ba3a829f7d",
    start: 2.7,
    end: 7.4,
    position: "bottom-right-safe"
  });
});

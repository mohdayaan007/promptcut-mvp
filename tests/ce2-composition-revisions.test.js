import test from "node:test";
import assert from "node:assert/strict";
import { CE1_SOURCE_ID } from "../src/lib/editor-core/ce1-founder-reel.js";
import { CE2_SLIGHTLY_BRIGHTER_DELTA, applyCe2Revision, createCe2Composition, createCe2RevisionExample, parseCe2RevisionRequest, validateCe2Composition } from "../src/lib/editor-core/ce2-composition-revisions.js";

const sources = [{ sourceId: CE1_SOURCE_ID, duration: 117.098089, width: 1280, height: 720, hasAudio: true }];
const layer = (composition, id) => composition.textLayers.find((candidate) => candidate.id === id);

test("CE-2 gives CE-1 text layers stable identities and preserves the baseline", () => {
  const base = createCe2Composition();
  validateCe2Composition(base, sources);
  assert.equal(layer(base, "founder-family-name").text, "AYAAN");
  const next = applyCe2Revision(base, "Change all yellow text to red.", sources);
  assert.equal(base.revision, 0); assert.equal(next.revision, 1);
  assert.equal(layer(base, "founder-family-name").colour, "yellow");
  assert.equal(layer(next, "founder-family-name").colour, "red");
  assert.equal(layer(next, "product-chatgpt").colour, "charcoal");
});

test("CE-2 corrects only a separately seeded legacy title fixture", () => {
  const seeded = createCe2Composition({ seededOldName: true });
  const corrected = applyCe2Revision(seeded, "Change Mohammed Ayan to Mohammed Ayaan.", sources);
  assert.equal(layer(seeded, "founder-family-name").text, "AYAN");
  assert.equal(layer(corrected, "founder-family-name").text, "AYAAN");
  assert.deepEqual(corrected.plan, seeded.plan);
});

test("CE-2 defines slightly brighter as a conservative footage-only delta", () => {
  const base = createCe2Composition(); const next = applyCe2Revision(base, "Make the footage slightly brighter.", sources);
  const visual = next.plan.operations.find((operation) => operation.type === "visual_adjustment");
  assert.equal(visual.brightness, CE2_SLIGHTLY_BRIGHTER_DELTA);
  assert.deepEqual(next.textLayers, base.textLayers);
  assert.throws(() => applyCe2Revision(next, "Make the footage slightly brighter.", sources), /already revised/);
});

test("CE-2 rejects ambiguous, invalid, and unsupported changes", () => {
  assert.throws(() => parseCe2RevisionRequest("Make it look better."), /unsupported or ambiguous/);
  const invalid = createCe2Composition(); invalid.textLayers[0].id = "invented-layer";
  assert.throws(() => validateCe2Composition(invalid, sources), /invalid editable layer/);
  assert.throws(() => createCe2RevisionExample("unknown", sources), /unknown CE-2 example/);
});

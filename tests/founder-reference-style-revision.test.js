import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceStyleV1Composition, applyReferenceStyleV1Revision } from "../src/lib/editor-core/reference-style-v1-composition.js";

const profile = { colour: { treatment: { recipe: { temperature: 0.2, saturation: -0.1, blackLift: -0.15 } } } };
test("reference colour refinements are narrow immutable revisions", () => {
  const base = createReferenceStyleV1Composition({ title: "A Trip to New York", profile });
  const stronger = applyReferenceStyleV1Revision(base, "Match the reference more strongly.", 15);
  const reduced = applyReferenceStyleV1Revision(stronger, "Reduce the intensity slightly.", 15);
  assert.equal(base.profile.colour.treatment.recipe.temperature, 0.2);
  assert.equal(stronger.profile.colour.treatment.recipe.temperature, 0.27);
  assert.equal(reduced.profile.colour.treatment.recipe.temperature, 0.2025);
  assert.equal(stronger.title.text, base.title.text);
  assert.throws(() => applyReferenceStyleV1Revision(base, "Make it amazing.", 15), /unsupported/);
});

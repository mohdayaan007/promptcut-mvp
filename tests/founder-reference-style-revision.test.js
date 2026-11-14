import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceStyleV1Composition, applyReferenceStyleV1Revision } from "../src/lib/editor-core/reference-style-v1-composition.js";

const profile = {
  colour: {
    treatment: {
      recipe: {
        temperature: 0.2,
        saturation: -0.1,
        blackLift: -0.15,
        channelCurves: {
          red: [{ input: 0.15, output: 0.12 }, { input: 0.5, output: 0.47 }, { input: 0.85, output: 0.83 }],
          green: [{ input: 0.15, output: 0.14 }, { input: 0.5, output: 0.49 }, { input: 0.85, output: 0.85 }],
          blue: [{ input: 0.15, output: 0.16 }, { input: 0.5, output: 0.53 }, { input: 0.85, output: 0.87 }]
        }
      }
    }
  }
};
test("reference colour refinements are narrow immutable revisions", () => {
  const base = createReferenceStyleV1Composition({ title: "A Trip to New York", profile });
  const stronger = applyReferenceStyleV1Revision(base, "Match the reference more strongly.", 15);
  const reduced = applyReferenceStyleV1Revision(stronger, "Reduce the intensity slightly.", 15);
  assert.equal(base.profile.colour.treatment.recipe.temperature, 0.2);
  assert.equal(stronger.profile.colour.treatment.recipe.temperature, 0.27);
  assert.equal(reduced.profile.colour.treatment.recipe.temperature, 0.2025);
  assert.notDeepEqual(stronger.profile.colour.treatment.recipe.channelCurves, base.profile.colour.treatment.recipe.channelCurves);
  assert.equal(stronger.title.text, base.title.text);
  assert.throws(() => applyReferenceStyleV1Revision(base, "Make it amazing.", 15), /unsupported/);
});

test("text revisions retain the V3 channel treatment", () => {
  const base = createReferenceStyleV1Composition({ title: "A Trip to New York", profile });
  const revised = applyReferenceStyleV1Revision(base, "Change A Trip to New York to Exploring Bangalore.", 15);
  assert.equal(revised.title.text, "Exploring Bangalore");
  assert.deepEqual(revised.profile.colour.treatment.recipe.channelCurves, base.profile.colour.treatment.recipe.channelCurves);
});

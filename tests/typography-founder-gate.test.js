import assert from "node:assert/strict";
import test from "node:test";
import { applyTypographyV1aToPlan, assertFounderTypographyV1a, founderTypographyV1aEnabled, validateTypographyV1a } from "@/lib/editor-core/typography-v1a";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";

test("Typography V1A is disabled by default and requires both flag and trusted founder authorization", () => {
  assert.equal(founderTypographyV1aEnabled({ env: {}, founderAuthorized: true }), false);
  assert.equal(founderTypographyV1aEnabled({ env: { FOUNDER_TYPOGRAPHY_V1A_ENABLED: "true" }, founderAuthorized: false }), false);
  assert.equal(founderTypographyV1aEnabled({ env: { FOUNDER_TYPOGRAPHY_V1A_ENABLED: "true" }, founderAuthorized: true }), true);
  assert.throws(() => assertFounderTypographyV1a({ env: { FOUNDER_TYPOGRAPHY_V1A_ENABLED: "true" }, founderAuthorized: false }), /not enabled/);
});

test("Typography V1A accepts only bundled font identifiers and bounded metadata", () => {
  assert.deepEqual(validateTypographyV1a({ version: 1, font: "instrumentSerif" }), { version: 1, font: "instrumentSerif" });
  assert.equal(validateTypographyV1a(null), null);
  assert.throws(() => validateTypographyV1a({ version: 1, font: "Anton" }), /invalid/);
  assert.throws(() => validateTypographyV1a({ version: 1, font: "inter", owner: "client" }), /invalid/);
});

test("Typography V1A applies the selected bundled font without erasing explicit rich-run fonts", () => {
  const plan = {
    version: "1",
    operations: [{
      type: "title", text: "HELLO WORLD", start: 0, end: 2, position: "center", size: "medium", color: "white", weight: "regular", font: "inter",
      runs: [{ text: "HELLO ", font: "jetbrainsMono" }, { text: "WORLD" }]
    }]
  };
  const result = validateEditPlan(applyTypographyV1aToPlan(plan, { version: 1, font: "instrumentSerif" }));
  assert.equal(result.operations[0].font, "instrumentSerif");
  assert.equal(result.operations[0].runs[0].font, "jetbrainsMono");
  assert.equal(result.operations[0].runs[1].font, "instrumentSerif");
  assert.throws(() => applyTypographyV1aToPlan({ version: "1", operations: [] }, { version: 1, font: "inter" }), /Add a title/);
});

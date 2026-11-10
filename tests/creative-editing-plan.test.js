import test from "node:test";
import assert from "node:assert/strict";
import { createCreativeBenchmarkManifest, scoreCreativeBenchmarkCase } from "../src/lib/editor-core/creative-benchmark.js";
import { CREATIVE_PLAN_VERSION, buildCreativeEvaluationPrompt, createCreativeEditingPlanJsonSchema, createCreativePlanPromptContract, validateCreativeEditingPlan } from "../src/lib/editor-core/creative-editing-plan.js";

const sources = [{ sourceId: "source-1", duration: 20 }];
const valid = { version: CREATIVE_PLAN_VERSION, decisions: [{ kind: "cut", sourceId: "source-1", start: 1, end: 8, evidenceIds: ["frame-1"], rationale: "clear action" }, { kind: "style", profileId: "cinematic", evidenceIds: ["frame-1"], rationale: "supported visual direction" }], requirements: [] };

test("creative plan compiles only source-grounded executable decisions", () => {
  const plan = validateCreativeEditingPlan(valid, { sourceCatalog: sources, evidenceIds: ["frame-1"] });
  assert.equal(plan.executionPlan.version, "2");
  assert.equal(plan.executionPlan.operations[0].clips[0].end, 8);
});
test("creative plan rejects fabricated evidence, ranges, and assets", () => {
  assert.throws(() => validateCreativeEditingPlan({ ...valid, decisions: [{ ...valid.decisions[0], evidenceIds: ["invented"] }], requirements: [] }, { sourceCatalog: sources, evidenceIds: ["frame-1"] }));
  assert.throws(() => validateCreativeEditingPlan({ ...valid, decisions: [{ ...valid.decisions[0], end: 21 }], requirements: [] }, { sourceCatalog: sources, evidenceIds: ["frame-1"] }));
  assert.throws(() => validateCreativeEditingPlan({ ...valid, requirements: [{ kind: "authorized_image_asset", assetId: "unknown", reason: "needed" }] }, { sourceCatalog: sources, evidenceIds: ["frame-1"] }));
});
test("benchmark reports simulated work as not yet verified", () => {
  const result = scoreCreativeBenchmarkCase({ caseId: "RVE5", plan: valid, sourceCatalog: sources, evidenceIds: ["frame-1"] });
  assert.equal(result.realModelStatus, "NOT_YET_VERIFIED");
  assert.equal(createCreativeBenchmarkManifest().cases.length, 5);
  assert.equal(createCreativePlanPromptContract({ sourceCatalog: sources, evidence: [{ evidenceId: "frame-1", sourceId: "source-1", start: 1, end: 2, summary: "movement" }] }).version, CREATIVE_PLAN_VERSION);
  assert.equal(createCreativeEditingPlanJsonSchema().properties.version.enum[0], CREATIVE_PLAN_VERSION);
  assert.match(buildCreativeEvaluationPrompt({ userPrompt: "make a reel", sourceCatalog: sources }), /make a reel/);
});

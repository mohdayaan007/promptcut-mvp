import test from "node:test";
import assert from "node:assert/strict";
import { CE0_LIMITS, runCreativeEvaluation } from "../src/lib/editor-core/creative-evaluation-runner.js";
import { CREATIVE_PLAN_VERSION } from "../src/lib/editor-core/creative-editing-plan.js";

const plan = { version: CREATIVE_PLAN_VERSION, decisions: [{ kind: "cut", sourceId: "source-1", start: 1, end: 8, evidenceIds: ["frame-1"], rationale: "supported" }], requirements: [] };
test("CE-0 runner makes exactly five one-shot calls and validates the final plan", async () => {
  let flashCalls = 0; let transcriptCalls = 0;
  const result = await runCreativeEvaluation({
    transcribe: async () => { transcriptCalls += 1; return { segments: [] }; },
    flash: async ({ phase }) => { flashCalls += 1; return { text: JSON.stringify(phase === "plan" ? plan : { phase }), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } }; },
    requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 117
  });
  assert.equal(transcriptCalls, 1); assert.equal(flashCalls, 4); assert.equal(result.usage.requestCount, CE0_LIMITS.requests);
});
test("CE-0 runner refuses a sixth request and does not retry failures", async () => {
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({}), flash: async () => ({ text: "{}" }), requests: [{}, {}, {}, {}, {}], sourceCatalog: [], evidenceIds: [], transcriptionSeconds: 1 }));
  let calls = 0;
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({}), flash: async () => { calls += 1; throw new Error("provider failure"); }, requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1 }));
  assert.equal(calls, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { CE0_LIMITS, runCreativeEvaluation } from "../src/lib/editor-core/creative-evaluation-runner.js";
import { CREATIVE_PLAN_VERSION } from "../src/lib/editor-core/creative-editing-plan.js";

const plan = { version: CREATIVE_PLAN_VERSION, decisions: [{ kind: "cut", sourceId: "source-1", start: 1, end: 8, evidenceIds: ["frame-1"], rationale: "supported" }], requirements: [] };
test("CE-0 runner makes exactly five one-shot calls and validates the final plan", async () => {
  let flashCalls = 0; let transcriptCalls = 0;
  const result = await runCreativeEvaluation({
    transcribe: async () => { transcriptCalls += 1; return { response: { usageMetadata: { totalTokenCount: 0 } }, value: { segments: [] } }; },
    flash: async ({ phase }) => { flashCalls += 1; return { text: JSON.stringify(phase === "plan" ? plan : { phase }), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } }; },
    requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 117
  });
  assert.equal(transcriptCalls, 1); assert.equal(flashCalls, 4); assert.equal(result.usage.requestCount, CE0_LIMITS.requests);
});
test("CE-0 runner refuses a sixth request and does not retry failures", async () => {
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({ response: {}, value: {} }), flash: async () => ({ text: "{}" }), requests: [{}, {}, {}, {}, {}], sourceCatalog: [], evidenceIds: [], transcriptionSeconds: 1 }));
  let calls = 0;
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({ response: {}, value: {} }), flash: async () => { calls += 1; throw new Error("provider failure"); }, requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1 }));
  assert.equal(calls, 1);
});
test("CE-0 records provider usage before a budget stop and only reuses explicit checkpoints", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(`${record.identity}:${record.stage}`, record), load: async (identity, stage) => records.get(`${identity}:${stage}`) || null };
  await assert.rejects(() => runCreativeEvaluation({
    transcribe: async () => ({ response: {}, value: { segments: [] } }),
    flash: async () => ({ text: JSON.stringify(plan), usageMetadata: { totalTokenCount: 30_000, candidatesTokenCount: 100 } }),
    requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1, checkpointStore: store, evaluationIdentity: "identity"
  }));
  assert.equal(records.get("identity:reference").status, "budget_exceeded");
  assert.equal(records.get("identity:reference").usage.flashInput, 29_900);
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({ response: {}, value: {} }), flash: async () => { throw new Error("must not run"); }, requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1, checkpointStore: store, evaluationIdentity: "identity", allowResume: true }));
});

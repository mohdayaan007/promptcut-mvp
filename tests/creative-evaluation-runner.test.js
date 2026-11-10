import test from "node:test";
import assert from "node:assert/strict";
import { CE0_LIMITS, CE0_REFERENCE_DIAGNOSTIC_LIMITS, loadSuccessfulReferenceAnalysis, loadSuccessfulSourceTranscript, runCreativeEvaluation, runReferenceDiagnostic } from "../src/lib/editor-core/creative-evaluation-runner.js";
import { CREATIVE_PLAN_VERSION } from "../src/lib/editor-core/creative-editing-plan.js";

const plan = { version: CREATIVE_PLAN_VERSION, decisions: [{ kind: "cut", sourceId: "source-1", start: 1, end: 8, evidenceIds: ["frame-1"], rationale: "supported" }], requirements: [] };
const overview = { candidates: [{ candidateId: "candidate-1", evidenceIds: ["frame-1"], observedAction: "speaker gestures", uncertainty: "coarse overview only" }] };
const fine = { reviews: [{ candidateId: "candidate-1", timingAssessment: "review within the observed window", uncertainty: "not frame precise" }] };
test("CE-0 runner makes exactly five one-shot calls and validates the final plan", async () => {
  let flashCalls = 0; let transcriptCalls = 0;
  const result = await runCreativeEvaluation({
    transcribe: async () => { transcriptCalls += 1; return { response: { usageMetadata: { totalTokenCount: 0 } }, value: { segments: [] } }; },
    flash: async ({ phase }) => { flashCalls += 1; return { text: JSON.stringify(phase === "plan" ? plan : phase === "overview" ? overview : phase === "fine" ? fine : { phase }), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } }; },
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
    flash: async () => ({ text: JSON.stringify(plan), usageMetadata: { totalTokenCount: 60_000, candidatesTokenCount: 100 } }),
    requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1, checkpointStore: store, evaluationIdentity: "identity"
  }));
  assert.equal(records.get("identity:reference").status, "budget_exceeded");
  assert.equal(records.get("identity:reference").usage.flashInput, 59_900);
  await assert.rejects(() => runCreativeEvaluation({ transcribe: async () => ({ response: {}, value: {} }), flash: async () => { throw new Error("must not run"); }, requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1, checkpointStore: store, evaluationIdentity: "identity", allowResume: true }));
});
test("reference diagnostic makes one call only and checkpoints usage before a limit stop", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(record.stage, record), load: async (_identity, stage) => records.get(stage) || null };
  let calls = 0;
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => { calls += 1; return { text: JSON.stringify(referenceAnalysis), usageMetadata: { totalTokenCount: 60_000, candidatesTokenCount: 1 } }; }, request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
  assert.equal(calls, 1); assert.equal(records.get("reference").status, "budget_exceeded");
});
const referenceAnalysis = { typography: "clear serif hierarchy", composition: "centered image and type", pacing: "short kinetic transitions", colourDirection: "muted cool palette", effectiveness: "contrast makes the message legible", limitations: "sampled frames cannot prove animation timing" };
test("reference diagnostic accepts a complete structured analysis and uses the bounded diagnostic allowance", async () => {
  let requestedTokens = 0;
  const result = await runReferenceDiagnostic({ flash: async ({ maxOutputTokens }) => { requestedTokens = maxOutputTokens; return { text: JSON.stringify(referenceAnalysis), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 40, totalTokenCount: 60 } }; }, request: {} });
  assert.deepEqual(result.analysis, referenceAnalysis);
  assert.equal(requestedTokens, CE0_REFERENCE_DIAGNOSTIC_LIMITS.maxOutputTokens);
});
test("reference diagnostic rejects an empty object and never reuses it as success", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(record.stage, record), load: async (_identity, stage) => records.get(stage) || null };
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => ({ text: "{}", usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } }), request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
  assert.equal(records.get("reference").status, "invalid_result");
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => { throw new Error("must not run"); }, request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
});
test("reference diagnostic records an empty response without treating it as a successful checkpoint", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(record.stage, record), load: async () => null };
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => ({ text: "", usageMetadata: { promptTokenCount: 42, totalTokenCount: 42 } }), request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
  assert.equal(records.get("reference").budgetCondition, "empty_response");
});
test("reference diagnostic records reported output exhaustion before stopping", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(record.stage, record), load: async () => null };
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => ({ text: JSON.stringify(referenceAnalysis), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 4_801, totalTokenCount: 4_802 } }), request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
  assert.equal(records.get("reference").budgetCondition, "flash_output_limit");
});
test("reference diagnostic only reuses a complete validated checkpoint", async () => {
  const checkpoint = { status: "completed", result: referenceAnalysis, usage: { requestCount: 1 } };
  const result = await runReferenceDiagnostic({ flash: async () => { throw new Error("must not run"); }, request: {}, checkpointStore: { load: async () => checkpoint }, evaluationIdentity: "reference" });
  assert.equal(result.reusedCheckpoint, true);
});
test("reference diagnostic rejects a historical completed checkpoint containing an empty analysis", async () => {
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => { throw new Error("must not run"); }, request: {}, checkpointStore: { load: async () => ({ status: "completed", result: {}, usage: { requestCount: 1 } }) }, evaluationIdentity: "reference" }));
});
test("reference diagnostic records reported usage when the provider JSON is malformed", async () => {
  const records = new Map(); const store = { save: async (record) => records.set(record.stage, record), load: async () => null };
  await assert.rejects(() => runReferenceDiagnostic({ flash: async () => ({ text: "{", usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 9, totalTokenCount: 51 } }), request: {}, checkpointStore: store, evaluationIdentity: "reference" }));
  assert.equal(records.get("reference").budgetCondition, "invalid_json");
  assert.equal(records.get("reference").usage.flashInput, 42);
});
test("loads a compatible complete reference checkpoint and omits the reference request", async () => {
  const checkpointStore = { load: async (identity, stage) => identity === "reference-identity" && stage === "reference" ? { status: "completed", result: referenceAnalysis, usage: { requestCount: 1, flashInput: 100, flashOutput: 100 } } : null };
  const importedReference = await loadSuccessfulReferenceAnalysis({ checkpointStore, evaluationIdentity: "reference-identity" });
  const phases = []; let transcriptCalls = 0;
  const result = await runCreativeEvaluation({
    transcribe: async () => { transcriptCalls += 1; return { response: {}, value: { segments: [] } }; },
    flash: async ({ phase, priorOutputs }) => { phases.push(phase); if (phase === "plan") assert.deepEqual(priorOutputs[0], referenceAnalysis); return { text: JSON.stringify(phase === "plan" ? plan : phase === "overview" ? overview : fine), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }; },
    requests: [{ phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 1, importedReference
  });
  assert.deepEqual(phases, ["overview", "fine", "plan"]); assert.equal(transcriptCalls, 1); assert.equal(result.usage.requestCount, 5); assert.equal(result.usage.flashInput, 103);
});
test("rejects missing or malformed imported reference checkpoints", async () => {
  await assert.rejects(() => loadSuccessfulReferenceAnalysis({ checkpointStore: { load: async () => null }, evaluationIdentity: "reference" }));
  await assert.rejects(() => loadSuccessfulReferenceAnalysis({ checkpointStore: { load: async () => ({ status: "completed", result: {}, usage: { requestCount: 1, flashInput: 1, flashOutput: 1 } }) }, evaluationIdentity: "reference" }));
});
test("the actual accepted reference usage fits the 55k CE-0 schedule without repeating reference", async () => {
  const phases = []; let transcriptions = 0;
  const result = await runCreativeEvaluation({
    transcribe: async () => { transcriptions += 1; return { response: {}, value: { segments: [] } }; },
    flash: async ({ phase }) => { phases.push(phase); return { text: JSON.stringify(phase === "plan" ? plan : phase === "overview" ? overview : fine), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }; },
    requests: [{ phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 117, importedReference: { analysis: referenceAnalysis, usage: { requestCount: 1, flashInput: 13_281, flashOutput: 315 } }
  });
  assert.equal(CE0_LIMITS.flashInputTokens, 55_000); assert.deepEqual(phases, ["overview", "fine", "plan"]); assert.equal(transcriptions, 1); assert.equal(result.usage.requestCount, 5); assert.equal(result.usage.flashInput, 13_284);
});
test("stops before transcription when a reused reference leaves insufficient Flash input budget", async () => {
  let calls = 0;
  await assert.rejects(() => runCreativeEvaluation({
    transcribe: async () => { calls += 1; return { response: {}, value: { segments: [] } }; }, flash: async () => { calls += 1; return { text: JSON.stringify(referenceAnalysis) }; },
    requests: [{ phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 117, importedReference: { analysis: referenceAnalysis, usage: { requestCount: 1, flashInput: 17_001, flashOutput: 315 } }
  }));
  assert.equal(calls, 0);
});
test("does not reuse an empty completed source-overview checkpoint", async () => {
  const checkpoints = new Map([
    ["evaluation:transcription", { status: "completed", requestCount: 2, usage: { flashInput: 13_281, flashOutput: 315 }, result: { sourceId: "source-1", segments: [] } }],
    ["evaluation:overview", { status: "completed", requestCount: 3, usage: { flashInput: 31_227, flashOutput: 875 }, result: {} }]
  ]);
  const store = { load: async (identity, stage) => checkpoints.get(`${identity}:${stage}`) || null };
  let providerCalls = 0;
  await assert.rejects(() => runCreativeEvaluation({
    transcribe: async () => { providerCalls += 1; throw new Error("must not run"); }, flash: async () => { providerCalls += 1; throw new Error("must not run"); },
    requests: [{ phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 10 }], evidenceIds: ["frame-1"], transcriptionSeconds: 117, checkpointStore: store, evaluationIdentity: "evaluation", allowResume: true, importedReference: { analysis: referenceAnalysis, usage: { requestCount: 1, flashInput: 13_281, flashOutput: 315 } }
  }));
  assert.equal(providerCalls, 0);
});
test("loads only a source-bound completed transcript checkpoint", async () => {
  const valid = await loadSuccessfulSourceTranscript({ checkpointStore: { load: async () => ({ status: "completed", usage: { requestCount: 2, flashInput: 13_281, flashOutput: 315, transcriptionSeconds: 116.992 }, result: { sourceId: "source-1", segments: [] } }) }, evaluationIdentity: "prior", sourceId: "source-1" });
  assert.equal(valid.usage.requestCount, 2);
  await assert.rejects(() => loadSuccessfulSourceTranscript({ checkpointStore: { load: async () => ({ status: "completed", usage: { requestCount: 2, flashInput: 13_281, flashOutput: 315 }, result: { sourceId: "source-2", segments: [] } }) }, evaluationIdentity: "prior", sourceId: "source-1" }));
});

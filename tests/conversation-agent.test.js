import test from "node:test";
import assert from "node:assert/strict";
import { applyEvidenceSelection, createConversationAgentEnvelope, isConversationAgentEnvelope } from "../src/lib/editor-core/conversation-agent.js";

const catalog = [
  { sourceId: "source-1", index: 0, ordinal: 1, filename: "a.mp4", duration: 30, width: 1280, height: 720, hasAudio: true },
  { sourceId: "source-2", index: 1, ordinal: 2, filename: "b.mp4", duration: 30, width: 1280, height: 720, hasAudio: true }
];

test("durable evidence envelope is bounded and retains only recent revision context", () => {
  const envelope = createConversationAgentEnvelope({ priorPlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 4, end: 20 }] }] }, prompt: "Keep the part where the product is visible", revisionHistory: Array.from({ length: 30 }, (_, version) => ({ version, prompt: `turn ${version}`, status: "completed" })) });
  assert.equal(isConversationAgentEnvelope(envelope), true);
  assert.equal(envelope.revisionHistory.length, 20);
  assert.equal(envelope.priorPlan.operations[0].clips[0].start, 4);
});

test("Director follow-up envelope preserves only explicit creator locks", () => {
  const envelope = createConversationAgentEnvelope({
    priorPlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 4, end: 24 }] }] },
    prompt: "Improve the pacing while preserving selected shots.", kind: "ugc_director_follow_up", locked: ["sequence", "title", "not-a-lock"]
  });
  assert.equal(envelope.kind, "ugc_director_follow_up");
  assert.deepEqual(envelope.locked, ["sequence", "title"]);
  assert.equal(isConversationAgentEnvelope(envelope), true);
});

test("evidence selection can narrow a visible edit but cannot revive removed footage", () => {
  const priorPlan = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 4, end: 12 }, { sourceId: "source-2", start: 5, end: 20 }] }, { type: "audio_volume", factor: 0.8 }] };
  const envelope = createConversationAgentEnvelope({ priorPlan, prompt: "Keep product shots" });
  const result = applyEvidenceSelection({ envelope, sourceCatalog: catalog, evidencePlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 8 }, { sourceId: "source-2", start: 15, end: 25 }] }] } });
  assert.deepEqual(result.operations[0].clips, [{ sourceId: "source-1", start: 4, end: 8 }, { sourceId: "source-2", start: 15, end: 20 }]);
  assert.deepEqual(result.operations.at(-1), { type: "audio_volume", factor: 0.8 });
  assert.deepEqual(priorPlan.operations[0].clips, [{ sourceId: "source-1", start: 4, end: 12 }, { sourceId: "source-2", start: 5, end: 20 }]);
});

test("evidence follow-up rejects extra operations instead of silently applying them", () => {
  const envelope = createConversationAgentEnvelope({ priorPlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] }, prompt: "Keep product shots and make it cinematic" });
  assert.throws(() => applyEvidenceSelection({ envelope, sourceCatalog: catalog, evidencePlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 2, end: 8 }] }, { type: "color_grade", style: "cinematic" }] } }), /unsupported extra/i);
});

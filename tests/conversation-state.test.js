import test from "node:test";
import assert from "node:assert/strict";
import { applyConversationTurn, trimOutputStart, validateConversationPlan } from "../src/lib/editor-core/conversation-state.js";

const catalog = [{ sourceId: "source-1", index: 0, ordinal: 1, filename: "talking.mp4", duration: 60, width: 1280, height: 720, hasAudio: true }];
const base = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 20, end: 50 }] }] };

test("five-turn conversation keeps the selected source segment and replaces styles", () => {
  // Turn one is the existing Gemini-resolved Ahmed Perfumes selection.
  const trim = applyConversationTurn({ priorPlan: base, prompt: "Now trim the first five seconds too.", sourceCatalog: catalog });
  assert.deepEqual(trim.plan.operations[0].clips, [{ sourceId: "source-1", start: 25, end: 50 }]);
  const bw = applyConversationTurn({ priorPlan: trim.plan, prompt: "Also add black and white.", sourceCatalog: catalog });
  assert.equal(bw.plan.operations.at(-1).style, "bw");
  const cinematic = applyConversationTurn({ priorPlan: bw.plan, prompt: "Replace that with the cinematic style.", sourceCatalog: catalog });
  assert.equal(cinematic.plan.operations.filter((operation) => operation.type === "color_grade").length, 1);
  assert.equal(cinematic.plan.operations.at(-1).style, "cinematic");
  const normal = applyConversationTurn({ priorPlan: cinematic.plan, prompt: "Bring it back to normal.", sourceCatalog: catalog });
  assert.deepEqual(normal.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 25, end: 50 }] }]);
});

test("output-relative trim crosses clip boundaries without modifying originals", () => {
  const plan = { version: "2", operations: [{ type: "sequence", clips: [
    { sourceId: "source-1", start: 0, end: 3 }, { sourceId: "source-1", start: 10, end: 20 }
  ] }] };
  const result = trimOutputStart(plan, 5, catalog);
  assert.deepEqual(result.operations[0].clips, [{ sourceId: "source-1", start: 12, end: 20 }]);
  assert.deepEqual(plan.operations[0].clips[0], { sourceId: "source-1", start: 0, end: 3 });
});

test("unsafe conversational ambiguity does not create a changed plan", () => {
  assert.throws(() => applyConversationTurn({ priorPlan: base, prompt: "Make it amazing somehow", sourceCatalog: catalog }), /couldn’t safely/i);
});

test("output-relative trim refuses a prior speed change rather than guessing source timing", () => {
  const withSpeed = { ...base, operations: [...base.operations, { type: "speed", factor: 2 }] };
  assert.throws(() => applyConversationTurn({ priorPlan: withSpeed, prompt: "Trim the first five seconds", sourceCatalog: catalog }), /speed change is not supported/i);
});

test("supported follow-up effects replace incompatible settings while preserving the selected sequence", () => {
  const vertical = applyConversationTurn({ priorPlan: base, prompt: "Make it vertical and add a fade out.", sourceCatalog: catalog });
  assert.deepEqual(vertical.plan.operations[0], base.operations[0]);
  assert.equal(vertical.plan.operations.find((operation) => operation.type === "crop").aspect_ratio, "9:16");
  assert.equal(vertical.plan.operations.find((operation) => operation.type === "fade").mode, "out");

  const landscape = applyConversationTurn({ priorPlan: vertical.plan, prompt: "Make it landscape.", sourceCatalog: catalog });
  assert.deepEqual(landscape.plan.operations.filter((operation) => operation.type === "crop"), [{ type: "crop", aspect_ratio: "16:9" }]);
  assert.doesNotThrow(() => validateConversationPlan(landscape.plan, catalog));
});

test("unsupported contextual removals and timeline ranges fail without changing the prior plan", () => {
  assert.throws(() => applyConversationTurn({ priorPlan: base, prompt: "Remove the subtitles.", sourceCatalog: catalog }), /unchanged/i);
  assert.throws(() => applyConversationTurn({ priorPlan: base, prompt: "Trim 0:05 to 0:20.", sourceCatalog: catalog }), /fresh media understanding/i);
  assert.deepEqual(base.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 20, end: 50 }] }]);
});

test("open-ended conversation retains cumulative timing and one active style across 25 turns", () => {
  let plan = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 10, end: 60 }] }] };
  const turns = Array.from({ length: 25 }, (_, index) => {
    if (index % 5 === 0) return "Bring it back to normal.";
    if (index % 3 === 0) return "Replace that with the cinematic style.";
    if (index % 3 === 1) return "Also add black and white.";
    return "Trim the first one second.";
  });
  for (const prompt of turns) {
    plan = applyConversationTurn({ priorPlan: plan, prompt, sourceCatalog: catalog }).plan;
    assert.doesNotThrow(() => validateConversationPlan(plan, catalog));
    assert.ok(plan.operations.filter((operation) => operation.type === "color_grade").length <= 1);
  }
  const sequence = plan.operations.find((operation) => operation.type === "sequence");
  assert.deepEqual(sequence.clips, [{ sourceId: "source-1", start: 16, end: 60 }]);
});

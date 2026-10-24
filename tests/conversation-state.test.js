import test from "node:test";
import assert from "node:assert/strict";
import { applyConversationTurn, trimOutputStart } from "../src/lib/editor-core/conversation-state.js";

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

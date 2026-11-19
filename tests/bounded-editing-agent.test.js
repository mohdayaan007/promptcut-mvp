import test from "node:test";
import assert from "node:assert/strict";
import { EditingAgentError, runBoundedEditingAgent } from "../src/lib/editor-core/bounded-editing-agent.js";

test("bounded agent uses only supplied evidence tools then submits one validated plan", async () => {
  const calls = [];
  const decisions = [
    { tool: "inspect_project", input: {} },
    { tool: "inspect_transcript", input: { sourceId: "source-1" } },
    { tool: "submit_plan", input: { selection: "product" } }
  ];
  const result = await runBoundedEditingAgent({
    context: { prompt: "Keep product shots" }, maxSteps: 3,
    adapter: async ({ observations, remainingSteps }) => { assert.equal(remainingSteps, 3 - observations.length); return decisions[observations.length]; },
    tools: {
      inspect_project: async () => ({ visibleDuration: 20 }),
      inspect_transcript: async () => ({ sourceId: "source-1", segments: [] }),
      submit_plan: async ({ selection }) => { calls.push(selection); return { version: "2", operations: [] }; }
    }
  });
  assert.deepEqual(calls, ["product"]);
  assert.equal(result.steps, 3);
  assert.equal(result.plan.version, "2");
});

test("bounded agent rejects unavailable tools, oversized tool evidence, and unfinished loops", async () => {
  await assert.rejects(() => runBoundedEditingAgent({ adapter: async () => ({ tool: "shell", input: {} }), tools: {}, context: {} }), (error) => error instanceof EditingAgentError && error.code === "AGENT_INVALID_TOOL_CALL");
  await assert.rejects(() => runBoundedEditingAgent({ adapter: async () => ({ tool: "inspect_project", input: {} }), tools: { inspect_project: async () => ({ text: "x".repeat(200) }) }, context: {}, maxToolPayloadBytes: 32 }), (error) => error.code === "AGENT_TOOL_RESULT_TOO_LARGE");
  await assert.rejects(() => runBoundedEditingAgent({ adapter: async () => ({ tool: "inspect_project", input: {} }), tools: { inspect_project: async () => ({}) }, context: {}, maxSteps: 1 }), (error) => error.code === "AGENT_STEP_LIMIT");
});

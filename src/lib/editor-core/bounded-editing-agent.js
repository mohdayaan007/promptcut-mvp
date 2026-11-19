/**
 * Provider-neutral orchestration shell. Providers return a single typed tool
 * call per turn; only server-supplied tools can inspect evidence or submit a
 * plan. This module deliberately has no media, shell, network, or client I/O.
 */
export class EditingAgentError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export const EDITING_AGENT_TOOL_NAMES = Object.freeze([
  "inspect_project", "inspect_media_evidence", "inspect_transcript",
  "propose_plan", "submit_plan"
]);

function safeJson(value) { return JSON.parse(JSON.stringify(value)); }

function validCall(value) {
  return value && typeof value === "object" && EDITING_AGENT_TOOL_NAMES.includes(value.tool) && value.input && typeof value.input === "object";
}

/**
 * Runs a finite, observable tool loop. `adapter` can be Gemini function
 * calling, a deterministic policy, or a test double. Tool results are fed
 * back as data; no provider receives arbitrary process access.
 */
export async function runBoundedEditingAgent({ adapter, tools, context, maxSteps = 4, maxToolPayloadBytes = 48_000, executionController }) {
  if (typeof adapter !== "function" || !tools || typeof tools !== "object") throw new EditingAgentError("AGENT_CONFIGURATION");
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) throw new EditingAgentError("AGENT_STEP_LIMIT");
  const observations = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    executionController?.throwIfCancelled?.();
    const decision = await adapter({ context: safeJson(context), observations: safeJson(observations), tools: EDITING_AGENT_TOOL_NAMES, remainingSteps: maxSteps - step + 1 });
    if (!validCall(decision)) throw new EditingAgentError("AGENT_INVALID_TOOL_CALL", "The editing agent returned an invalid tool request.");
    const handler = tools[decision.tool];
    if (typeof handler !== "function") throw new EditingAgentError("AGENT_TOOL_UNAVAILABLE", `The requested editing tool is unavailable: ${decision.tool}`);
    const result = await handler(safeJson(decision.input));
    const serialized = JSON.stringify(result ?? null);
    if (serialized.length > maxToolPayloadBytes) throw new EditingAgentError("AGENT_TOOL_RESULT_TOO_LARGE");
    observations.push({ tool: decision.tool, result: JSON.parse(serialized) });
    if (decision.tool === "submit_plan") return { plan: result, steps: observations.length, observations };
  }
  throw new EditingAgentError("AGENT_STEP_LIMIT", "The editing agent reached its step limit without a validated plan.");
}

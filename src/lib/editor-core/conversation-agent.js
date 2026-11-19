import { validateEditPlan } from "@/lib/editor-core/plan-validator";

export const CONVERSATION_AGENT_VERSION = "conversation-agent-v1";

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fullSequence(sourceCatalog) {
  return sourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration }));
}

function visibleSequence(plan, sourceCatalog) {
  const sequence = plan?.operations?.find((operation) => operation.type === "sequence");
  return sequence?.clips ? clone(sequence.clips) : fullSequence(sourceCatalog);
}

/** A durable, server-owned follow-up envelope. It is replaced with a normal plan before rendering. */
export function createConversationAgentEnvelope({ priorPlan, prompt, revisionHistory = [] }) {
  if (!priorPlan?.operations || typeof prompt !== "string" || !prompt.trim()) throw new Error("Conversation context is invalid");
  return {
    version: CONVERSATION_AGENT_VERSION,
    kind: "evidence_follow_up",
    prompt: prompt.trim(),
    priorPlan: clone(priorPlan),
    revisionHistory: revisionHistory.slice(-20).map(({ version, prompt: priorPrompt, status }) => ({ version, prompt: String(priorPrompt || "").slice(0, 1000), status }))
  };
}

export function isConversationAgentEnvelope(value) {
  return Boolean(value && value.version === CONVERSATION_AGENT_VERSION && value.kind === "evidence_follow_up" && value.priorPlan?.operations && typeof value.prompt === "string");
}

function intersectSelection(priorClips, selectedClips) {
  const clips = [];
  for (const selected of selectedClips) {
    for (const prior of priorClips) {
      if (selected.sourceId !== prior.sourceId) continue;
      const start = Math.max(selected.start, prior.start);
      const end = Math.min(selected.end, prior.end);
      if (end > start) clips.push({ sourceId: selected.sourceId, start, end });
    }
  }
  return clips;
}

/**
 * Evidence may narrow an already-edited visible timeline, but may never revive
 * footage a creator removed. The planner may supply a source sequence only;
 * unrelated operations are deliberately rejected rather than silently merged.
 */
export function applyEvidenceSelection({ envelope, evidencePlan, sourceCatalog }) {
  if (!isConversationAgentEnvelope(envelope)) throw new Error("Conversation context is invalid");
  validateEditPlan(evidencePlan, { sourceCatalog });
  const evidenceSequence = evidencePlan.operations?.find((operation) => operation.type === "sequence");
  if (!evidenceSequence?.clips?.length) throw new Error("I couldn’t verify a safe footage selection for that follow-up.");
  const allowed = new Set(["sequence"]);
  if (evidencePlan.operations.some((operation) => !allowed.has(operation.type))) throw new Error("That evidence-based follow-up includes unsupported extra changes.");
  const clips = intersectSelection(visibleSequence(envelope.priorPlan, sourceCatalog), evidenceSequence.clips);
  if (!clips.length) throw new Error("That requested footage is not present in the current edit.");
  const plan = clone(envelope.priorPlan);
  plan.version = "2";
  plan.operations = [{ type: "sequence", clips }, ...plan.operations.filter((operation) => !["sequence", "trim", "merge"].includes(operation.type))];
  return validateEditPlan(plan, { sourceCatalog });
}

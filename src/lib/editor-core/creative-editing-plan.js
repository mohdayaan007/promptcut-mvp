import { validateEditPlan } from "@/lib/editor-core/plan-validator";

export const CREATIVE_PLAN_VERSION = "creative/1";
const MAX_DECISIONS = 20;
const REQUIREMENT_KINDS = new Set(["authorized_image_asset", "motion_graphics", "hand_drawn_graphics", "music_timing", "missing_footage", "unsupported_operation"]);

function fail(message) { throw new Error(`Invalid creative editing plan: ${message}`); }
function time(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function text(value, name) { if (typeof value !== "string" || !value.trim() || value.length > 500) fail(`${name} must be bounded text`); }

/**
 * Validates a model-facing creative decision envelope, then delegates every
 * executable instruction to the established V2 plan validator. This envelope
 * is evidence/accountability metadata, never an alternative renderer format.
 */
export function validateCreativeEditingPlan(plan, { sourceCatalog = [], evidenceIds = [], authorizedAssetIds = [] } = {}) {
  if (!plan || plan.version !== CREATIVE_PLAN_VERSION || !Array.isArray(plan.decisions) || !Array.isArray(plan.requirements)) fail("version, decisions, and requirements are required");
  if (!plan.decisions.length || plan.decisions.length > MAX_DECISIONS) fail("decisions must be a bounded non-empty array");
  const sources = new Map(sourceCatalog.map((source) => [source.sourceId, source]));
  const knownEvidence = new Set(evidenceIds);
  const knownAssets = new Set(authorizedAssetIds);
  const clips = [];
  const operations = [];

  for (const decision of plan.decisions) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) fail("decision must be an object");
    if (!["cut", "title", "style"].includes(decision.kind)) fail("decision kind is unsupported");
    if (!Array.isArray(decision.evidenceIds) || !decision.evidenceIds.length || decision.evidenceIds.some((id) => !knownEvidence.has(id))) fail("decision requires known evidence IDs");
    text(decision.rationale, "decision rationale");
    if (decision.kind === "cut") {
      const source = sources.get(decision.sourceId);
      if (!source || !time(decision.start) || !time(decision.end) || decision.end <= decision.start || decision.end > source.duration + 0.01) fail("cut must use a source-local supported range");
      clips.push({ sourceId: decision.sourceId, start: decision.start, end: decision.end });
    }
    if (decision.kind === "title") {
      const { kind, evidenceIds: ignoredEvidence, rationale, ...operation } = decision;
      operations.push({ type: "title", ...operation });
    }
    if (decision.kind === "style") {
      if (typeof decision.profileId !== "string") fail("style requires a profileId");
      operations.push({ type: "style_profile", profileId: decision.profileId, ...(decision.strength ? { strength: decision.strength } : {}) });
    }
  }
  for (const requirement of plan.requirements) {
    if (!requirement || typeof requirement !== "object" || !REQUIREMENT_KINDS.has(requirement.kind)) fail("requirement kind is unsupported");
    text(requirement.reason, "requirement reason");
    if (requirement.kind === "authorized_image_asset" && !knownAssets.has(requirement.assetId)) fail("image requirement needs an authorized asset");
  }
  if (!clips.length) fail("at least one source-grounded cut is required");
  const executionPlan = validateEditPlan({ version: "2", operations: [{ type: "sequence", clips }, ...operations] }, { sourceCatalog });
  return Object.freeze({ version: CREATIVE_PLAN_VERSION, decisions: Object.freeze(plan.decisions.map((decision) => Object.freeze({ ...decision, evidenceIds: Object.freeze([...decision.evidenceIds]) }))), requirements: Object.freeze(plan.requirements.map((requirement) => Object.freeze({ ...requirement }))), executionPlan });
}

export function createCreativePlanPromptContract({ sourceCatalog = [], evidence = [] } = {}) {
  return Object.freeze({ version: CREATIVE_PLAN_VERSION, sourceCatalog: sourceCatalog.map(({ sourceId, duration }) => ({ sourceId, duration })), evidence: evidence.map(({ evidenceId, sourceId, start, end, summary }) => ({ evidenceId, sourceId, start, end, summary })), rules: ["Use only supplied source IDs and evidence IDs.", "All cut timestamps are source-local.", "Use requirements—not invented operations—for external assets, graphics, music timing, or missing footage.", "Return a bounded abstention requirement when evidence cannot support an edit."] });
}

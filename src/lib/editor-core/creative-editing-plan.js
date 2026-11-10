import { validateEditPlan } from "@/lib/editor-core/plan-validator";

export const CREATIVE_PLAN_VERSION = "creative/1";
const MAX_DECISIONS = 20;
const REQUIREMENT_KINDS = new Set(["authorized_image_asset", "motion_graphics", "hand_drawn_graphics", "music_timing", "missing_footage", "unsupported_operation"]);
const DECISION_FIELDS = {
  cut: new Set(["kind", "sourceId", "start", "end", "evidenceIds", "rationale"]),
  title: new Set(["kind", "text", "start", "end", "position", "size", "color", "weight", "font", "fontIntent", "runs", "readability", "renderCaseStyle", "presentation", "evidenceIds", "rationale"]),
  style: new Set(["kind", "profileId", "strength", "evidenceIds", "rationale"])
};

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
    if (Object.keys(decision).some((field) => !DECISION_FIELDS[decision.kind].has(field))) fail("decision includes an unsupported field");
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
    if (Object.keys(requirement).some((field) => !["kind", "reason", "assetId"].includes(field))) fail("requirement includes an unsupported field");
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

/** Gemini-compatible shallow schema; the server remains authoritative for all timing and assets. */
export function createCreativeEditingPlanJsonSchema() {
  const evidenceIds = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 };
  const rationale = { type: "string", maxLength: 500 };
  return {
    type: "object", additionalProperties: false,
    properties: {
      version: { type: "string", enum: [CREATIVE_PLAN_VERSION] },
      decisions: { type: "array", minItems: 1, maxItems: MAX_DECISIONS, items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["cut", "title", "style"] }, sourceId: { type: "string" }, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 }, text: { type: "string", maxLength: 200 }, position: { type: "string" }, size: { type: "string" }, color: { type: "string" }, weight: { type: "string" }, font: { type: "string" }, fontIntent: { type: "string" }, runs: { type: "array", maxItems: 20, items: { type: "object" } }, readability: { type: "object" }, renderCaseStyle: { type: "string" }, presentation: { type: "string" }, profileId: { type: "string" }, strength: { type: "string" }, evidenceIds, rationale }, required: ["kind", "evidenceIds", "rationale"] } },
      requirements: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: [...REQUIREMENT_KINDS] }, reason: { type: "string", maxLength: 500 }, assetId: { type: "string" } }, required: ["kind", "reason"] } }
    }, required: ["version", "decisions", "requirements"]
  };
}

export function buildCreativeEvaluationPrompt({ userPrompt, referenceEvidence = [], sourceEvidence = [], sourceCatalog = [] } = {}) {
  return [
    "You are evaluating a requested video edit. Reference evidence describes aesthetic inspiration; source evidence describes the footage that may actually be edited.",
    "Return only creative/1 JSON matching the supplied schema. Do not invent source content, timestamps, evidence IDs, assets, URLs, code, FFmpeg, or animation instructions.",
    "Use only source-local cut ranges backed by source evidence. Use requirements for graphics, images, music timing, missing footage, or capabilities not executable by the supplied plan.",
    "Preserve speech unless source evidence explicitly supports an alternative. Be restrained: prefer a smaller coherent reel over unsupported cuts.",
    `User request: ${userPrompt}`,
    `Reference aesthetic evidence: ${JSON.stringify(referenceEvidence)}`,
    `Authoritative source evidence: ${JSON.stringify(sourceEvidence)}`,
    `Authoritative source catalog: ${JSON.stringify(sourceCatalog.map(({ sourceId, duration }) => ({ sourceId, duration })))}`
  ].join("\n\n");
}

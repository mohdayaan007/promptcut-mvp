import { CREATIVE_PLAN_VERSION, validateCreativeEditingPlan } from "@/lib/editor-core/creative-editing-plan";

export const CREATIVE_BENCHMARK_CASES = Object.freeze([
  { id: "RVE1", label: "Moved to Blore", focus: ["editorial storytelling", "expressive typography", "authorized overlays"], prompt: "Make a concise moving-to-a-new-city story with expressive titles; identify any external image assets you need." },
  { id: "RVE2", label: "Nasal Spray", focus: ["documentary clarity", "interviews", "evidence graphics"], prompt: "Make a restrained documentary explanation; preserve clear interview moments and identify unsupported explanatory graphics." },
  { id: "RVE3", label: "Put Myself Out", focus: ["spatial typography", "hand-drawn graphics", "visual storytelling"], prompt: "Build a personal story with sparse spatial typography; state any hand-drawn graphics that cannot be made from supplied footage." },
  { id: "RVE5", label: "Film Yourself", focus: ["shot selection", "purposeful pacing", "warm continuity"], prompt: "Select the most cinematic source-local moments and create a coherent, warmly finished progression." },
  { id: "RVE7", label: "Deep House", focus: ["music-led restraint", "large typography", "precise timing"], prompt: "Create a restrained music-led edit; do not claim beat-safety unless supplied audio evidence verifies it." }
]);

const DIMENSIONS = ["creativeComprehension", "editorialJudgment", "timingAccuracy", "typographyComposition", "colourDirection", "sourceGrounding", "restraint", "instructionAdherence"];

/** Deterministic structural scoring only. It never represents mocked output as model quality. */
export function scoreCreativeBenchmarkCase({ caseId, plan, sourceCatalog, evidenceIds, authorizedAssetIds = [], modelEvidence = "simulated" }) {
  const benchmark = CREATIVE_BENCHMARK_CASES.find((entry) => entry.id === caseId);
  if (!benchmark) throw new Error("Unknown creative benchmark case");
  const validated = validateCreativeEditingPlan(plan, { sourceCatalog, evidenceIds, authorizedAssetIds });
  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, "not_scored"]));
  return Object.freeze({ caseId, modelEvidence, structurallyValid: true, dimensions, realModelStatus: modelEvidence === "real" ? "requires_human_review" : "NOT_YET_VERIFIED", executionPlan: validated.executionPlan, requirements: validated.requirements });
}

export function createCreativeBenchmarkManifest() {
  return Object.freeze({ version: "ce0/1", cases: CREATIVE_BENCHMARK_CASES.map((entry) => ({ ...entry, evaluationCriteria: ["grounded source-local decisions", "explicit feasibility limits", "appropriate restraint", "human review of creative quality"] })) });
}

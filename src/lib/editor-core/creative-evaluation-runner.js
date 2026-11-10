import { validateCreativeEditingPlan } from "@/lib/editor-core/creative-editing-plan";

export const CE0_LIMITS = Object.freeze({ requests: 5, flashInputTokens: 55_000, flashOutputTokens: 4_800, flashOutputByPhase: Object.freeze([800, 1200, 1200, 1600]), dollars: 0.10 });
export const CE0_REFERENCE_DIAGNOSTIC_LIMITS = Object.freeze({ maxOutputTokens: 1200, dollars: 0.10 });
const FLASH_INPUT_ESTIMATES = Object.freeze([7000, 18_000, 18_000, 4000]);
const FLASH_STAGES = Object.freeze({ reference: Object.freeze({ input: FLASH_INPUT_ESTIMATES[0], output: CE0_LIMITS.flashOutputByPhase[0] }), overview: Object.freeze({ input: FLASH_INPUT_ESTIMATES[1], output: CE0_LIMITS.flashOutputByPhase[1] }), fine: Object.freeze({ input: FLASH_INPUT_ESTIMATES[2], output: CE0_LIMITS.flashOutputByPhase[2] }), plan: Object.freeze({ input: FLASH_INPUT_ESTIMATES[3], output: CE0_LIMITS.flashOutputByPhase[3] }) });
const FLASH_INPUT_PRICE = 0.75 / 1_000_000;
const FLASH_OUTPUT_PRICE = 3.75 / 1_000_000;
const TRANSCRIBE_PER_MINUTE = 0.005;

function fail(message) { throw new Error(`CE-0 evaluation blocked: ${message}`); }
export function usageOf(response = {}) {
  const value = response.usageMetadata || response.usage || {};
  const candidates = Number(value.candidatesTokenCount ?? value.outputTokens ?? 0);
  const thoughts = Number(value.thoughtsTokenCount ?? value.thoughtTokenCount ?? 0);
  const total = Number(value.totalTokenCount ?? value.totalTokens);
  const output = candidates + thoughts;
  const input = Number.isFinite(total) && total >= output ? total - output : Number(value.promptTokenCount ?? value.inputTokens ?? 0);
  return { input, output, provider: { prompt: Number(value.promptTokenCount ?? value.inputTokens ?? 0), candidates, thoughts, total: Number.isFinite(total) ? total : null } };
}
function cost({ flashInput, flashOutput, transcriptionSeconds }) { return flashInput * FLASH_INPUT_PRICE + flashOutput * FLASH_OUTPUT_PRICE + (transcriptionSeconds / 60) * TRANSCRIBE_PER_MINUTE; }
function json(response, phase) { if (typeof response?.text !== "string" || !response.text.trim()) fail(`${phase} returned no JSON`); try { return JSON.parse(response.text); } catch { fail(`${phase} returned invalid JSON`); } }
function referenceRejectionReason(error, budgetCondition) {
  if (budgetCondition) return budgetCondition;
  if (error?.message?.includes("returned no JSON")) return "empty_response";
  if (error?.message?.includes("returned invalid JSON")) return "invalid_json";
  return "invalid_analysis";
}
function referenceAnalysis(value) {
  const fields = ["typography", "composition", "pacing", "colourDirection", "effectiveness", "limitations"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => typeof value[field] !== "string" || !value[field].trim())) fail("reference returned an empty or invalid creative analysis");
  if (Object.keys(value).some((field) => !fields.includes(field))) fail("reference returned an empty or invalid creative analysis");
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field].trim()])));
}
function nonEmptyStageAnalysis(value, stage) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) fail(`${stage} returned an empty creative analysis`);
  return value;
}
function reusableStageResult(stage, value) {
  return ["reference", "overview", "fine"].includes(stage) ? nonEmptyStageAnalysis(value, stage) : value;
}
function sourceOverview(value, evidenceIds) {
  const known = new Set(evidenceIds);
  const candidates = value?.candidates;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) fail("overview returned no meaningful source observations");
  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.candidateId !== "string" || !candidate.candidateId || candidateIds.has(candidate.candidateId) || !Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length || candidate.evidenceIds.some((id) => typeof id !== "string" || !known.has(id)) || ["observedAction", "uncertainty"].some((field) => typeof candidate[field] !== "string" || !candidate[field].trim())) fail("overview returned invalid source observations");
    candidateIds.add(candidate.candidateId);
  }
  return value;
}
function sourceFineReview(value, overview) {
  const candidateIds = new Set(overview?.candidates?.map((candidate) => candidate.candidateId));
  const reviews = value?.reviews;
  if (!Array.isArray(reviews) || !reviews.length || reviews.some((review) => !review || typeof review !== "object" || !candidateIds.has(review.candidateId) || ["timingAssessment", "uncertainty"].some((field) => typeof review[field] !== "string" || !review[field].trim()))) fail("fine returned no meaningful timing review");
  return value;
}
function validatedStageResult(stage, value, { evidenceIds, overview }) {
  if (stage === "overview") return sourceOverview(value, evidenceIds);
  if (stage === "fine") return sourceFineReview(value, overview);
  return reusableStageResult(stage, value);
}
function normalizeImportedReference(value) {
  const usage = value?.usage;
  if (!usage || usage.requestCount !== 1 || !Number.isInteger(usage.flashInput) || usage.flashInput < 0 || !Number.isInteger(usage.flashOutput) || usage.flashOutput < 0) fail("reference checkpoint has invalid cumulative usage");
  return Object.freeze({ analysis: referenceAnalysis(value.analysis), usage: Object.freeze({ requestCount: usage.requestCount, flashInput: usage.flashInput, flashOutput: usage.flashOutput, transcriptionSeconds: 0 }) });
}

/** Loads only an integrity-checked, model/schema-bound reference checkpoint. */
export async function loadSuccessfulReferenceAnalysis({ checkpointStore, evaluationIdentity }) {
  if (!checkpointStore || !evaluationIdentity) fail("reference checkpoint identity is required");
  const checkpoint = await checkpointStore.load(evaluationIdentity, "reference");
  if (checkpoint?.status !== "completed") fail("no compatible completed reference checkpoint is available");
  return normalizeImportedReference({ analysis: checkpoint.result, usage: checkpoint.usage });
}
export async function loadSuccessfulSourceTranscript({ checkpointStore, evaluationIdentity, sourceId }) {
  if (!checkpointStore || !evaluationIdentity || !sourceId) fail("source transcript checkpoint identity is required");
  const checkpoint = await checkpointStore.load(evaluationIdentity, "transcription");
  const value = checkpoint?.result;
  if (checkpoint?.status !== "completed" || checkpoint?.usage?.requestCount !== 2 || checkpoint?.usage?.flashInput < 0 || checkpoint?.usage?.flashOutput < 0 || value?.sourceId !== sourceId || !Array.isArray(value.segments)) fail("no compatible completed source transcript checkpoint is available");
  return Object.freeze({ value, usage: Object.freeze({ requestCount: checkpoint.usage.requestCount, flashInput: checkpoint.usage.flashInput, flashOutput: checkpoint.usage.flashOutput, transcriptionSeconds: checkpoint.usage.transcriptionSeconds }) });
}

/**
 * CE-0 only. The supplied call functions must perform one request exactly once;
 * this module deliberately contains no retry or fallback path.
 */
export async function runCreativeEvaluation({ flash, transcribe, requests, sourceCatalog, evidenceIds, authorizedAssetIds = [], transcriptionSeconds, checkpointStore = null, evaluationIdentity = null, allowResume = false, importedReference: imported = null, importedTranscript = null }) {
  if (typeof flash !== "function" || typeof transcribe !== "function") fail("one-shot clients are required");
  const importedReference = imported ? normalizeImportedReference(imported) : null;
  const expectedPhases = importedReference ? ["overview", "fine", "plan"] : ["reference", "overview", "fine", "plan"];
  if (!Array.isArray(requests) || requests.length !== expectedPhases.length || requests.some((request, index) => request?.phase !== expectedPhases[index])) fail("invalid CE-0 Flash request schedule");
  if (!(transcriptionSeconds > 0)) fail("bounded transcription duration is required");
  if (importedTranscript && !importedReference) fail("imported transcript requires imported reference");
  if (importedTranscript && (importedTranscript.usage?.requestCount !== 2 || importedTranscript.usage.flashInput !== importedReference.usage.flashInput || importedTranscript.usage.flashOutput !== importedReference.usage.flashOutput)) fail("imported transcript does not match imported reference usage");
  const usage = { requestCount: importedTranscript?.usage.requestCount || importedReference?.usage.requestCount || 0, flashInput: importedTranscript?.usage.flashInput || importedReference?.usage.flashInput || 0, flashOutput: importedTranscript?.usage.flashOutput || importedReference?.usage.flashOutput || 0, transcriptionSeconds };
  const outputs = importedReference ? [importedReference.analysis] : [];
  const charge = () => cost(usage);
  const budgetCondition = () => usage.requestCount > CE0_LIMITS.requests ? "request_limit" : usage.flashInput > CE0_LIMITS.flashInputTokens ? "flash_input_limit" : usage.flashOutput > CE0_LIMITS.flashOutputTokens ? "flash_output_limit" : charge() > CE0_LIMITS.dollars ? "dollar_threshold" : null;
  const reservedFlashInput = requests.reduce((total, request) => total + FLASH_STAGES[request.phase].input, 0);
  const reservedFlashOutput = requests.reduce((total, request) => total + FLASH_STAGES[request.phase].output, 0);
  if (usage.flashInput + reservedFlashInput > CE0_LIMITS.flashInputTokens || usage.flashOutput + reservedFlashOutput > CE0_LIMITS.flashOutputTokens || charge() + reservedFlashInput * FLASH_INPUT_PRICE + reservedFlashOutput * FLASH_OUTPUT_PRICE > CE0_LIMITS.dollars) fail("remaining request schedule exceeds CE-0 budget");
  async function complete(stage, response, value) {
    const measured = usageOf(response);
    if (stage !== "transcription") { usage.flashInput += measured.input; usage.flashOutput += measured.output; }
    usage.requestCount += 1;
    const condition = budgetCondition();
    const record = { identity: evaluationIdentity, stage, status: condition ? "budget_exceeded" : "completed", requestCount: usage.requestCount, usage: { ...usage, estimatedCostUsd: Number(charge().toFixed(6)), provider: measured.provider }, budgetCondition: condition, result: value };
    if (checkpointStore && evaluationIdentity) await checkpointStore.save(record);
    if (condition) fail(`reported provider usage exceeds CE-0 budget (${condition})`);
    return value;
  }
  async function stage(stageName, invoke) {
    const checkpoint = checkpointStore && evaluationIdentity ? await checkpointStore.load(evaluationIdentity, stageName) : null;
    if (checkpoint?.status === "budget_exceeded") fail("manual review is required after a prior budget violation");
    if (checkpoint?.status === "completed" && allowResume) {
      usage.requestCount = Math.max(usage.requestCount, checkpoint.requestCount || 0);
      usage.flashInput = Math.max(usage.flashInput, checkpoint.usage?.flashInput || 0);
      usage.flashOutput = Math.max(usage.flashOutput, checkpoint.usage?.flashOutput || 0);
      return validatedStageResult(stageName, checkpoint.result, { evidenceIds, overview: outputs.at(-1) });
    }
    const response = await invoke();
    return complete(stageName, response.response || response, validatedStageResult(stageName, response.value ?? json(response, stageName), { evidenceIds, overview: outputs.at(-1) }));
  }

  const transcript = importedTranscript?.value || await stage("transcription", transcribe);

  for (let index = 0; index < requests.length; index += 1) {
    const outputLimit = FLASH_STAGES[requests[index].phase].output;
    const estimate = FLASH_STAGES[requests[index].phase].input;
    if (usage.flashInput + estimate > CE0_LIMITS.flashInputTokens || usage.flashOutput + outputLimit > CE0_LIMITS.flashOutputTokens || charge() + estimate * FLASH_INPUT_PRICE + outputLimit * FLASH_OUTPUT_PRICE > CE0_LIMITS.dollars) fail("next request exceeds CE-0 budget");
    outputs.push(await stage(requests[index].phase, async () => {
      const response = await flash({ ...requests[index], maxOutputTokens: outputLimit, transcript, priorOutputs: outputs });
      return { response, value: json(response, requests[index].phase) };
    }));
  }
  const plan = validateCreativeEditingPlan(outputs.at(-1), { sourceCatalog, evidenceIds, authorizedAssetIds });
  return Object.freeze({ plan, usage: Object.freeze({ ...usage, estimatedCostUsd: Number(charge().toFixed(6)) }), intermediateResultsRetained: false });
}

/** One-call CE-0 reference diagnostic. It deliberately cannot advance into source analysis. */
export async function runReferenceDiagnostic({ flash, request, checkpointStore = null, evaluationIdentity = null }) {
  if (typeof flash !== "function") fail("one-shot Flash client is required");
  const usage = { requestCount: 0, flashInput: 0, flashOutput: 0, transcriptionSeconds: 0 };
  const charge = () => cost(usage);
  const previous = checkpointStore && evaluationIdentity ? await checkpointStore.load(evaluationIdentity, "reference") : null;
  if (["budget_exceeded", "invalid_result"].includes(previous?.status)) fail("manual review is required after a prior invalid or over-budget response");
  if (previous?.status === "completed") return Object.freeze({ analysis: referenceAnalysis(previous.result), usage: previous.usage, reusedCheckpoint: true });
  const response = await flash({ ...request, phase: "reference", maxOutputTokens: CE0_REFERENCE_DIAGNOSTIC_LIMITS.maxOutputTokens });
  const measured = usageOf(response); usage.requestCount = 1; usage.flashInput = measured.input; usage.flashOutput = measured.output;
  const condition = usage.flashInput > CE0_LIMITS.flashInputTokens ? "flash_input_limit" : usage.flashOutput > CE0_LIMITS.flashOutputTokens ? "flash_output_limit" : charge() > CE0_LIMITS.dollars ? "dollar_threshold" : null;
  let analysis;
  try { analysis = referenceAnalysis(json(response, "reference")); } catch (error) {
    if (checkpointStore && evaluationIdentity) await checkpointStore.save({ identity: evaluationIdentity, stage: "reference", status: "invalid_result", requestCount: 1, usage: { ...usage, estimatedCostUsd: Number(charge().toFixed(6)), provider: measured.provider }, budgetCondition: referenceRejectionReason(error, condition), result: null });
    throw error;
  }
  if (checkpointStore && evaluationIdentity) await checkpointStore.save({ identity: evaluationIdentity, stage: "reference", status: condition ? "budget_exceeded" : "completed", requestCount: 1, usage: { ...usage, estimatedCostUsd: Number(charge().toFixed(6)), provider: measured.provider }, budgetCondition: condition, result: analysis });
  if (condition) fail(`reported provider usage exceeds CE-0 budget (${condition})`);
  return Object.freeze({ analysis, usage: Object.freeze({ ...usage, estimatedCostUsd: Number(charge().toFixed(6)), provider: measured.provider }), reusedCheckpoint: false });
}

export function createPrivateEvaluationReport({ result }) {
  return Object.freeze({ version: "ce0-evaluation/1", requestCount: result.usage.requestCount, usage: result.usage, creativePlan: result.plan, rawProviderResponsesRetained: false, providerUploadCleanup: "required_finally" });
}

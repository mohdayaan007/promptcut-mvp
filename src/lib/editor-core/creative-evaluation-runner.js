import { validateCreativeEditingPlan } from "@/lib/editor-core/creative-editing-plan";

export const CE0_LIMITS = Object.freeze({ requests: 5, flashInputTokens: 25_000, flashOutputTokens: 4_800, flashOutputByPhase: Object.freeze([800, 1200, 1200, 1600]), dollars: 0.10 });
const FLASH_INPUT_ESTIMATES = Object.freeze([7000, 8500, 5500, 4000]);
const FLASH_INPUT_PRICE = 0.75 / 1_000_000;
const FLASH_OUTPUT_PRICE = 3.75 / 1_000_000;
const TRANSCRIBE_PER_MINUTE = 0.005;

function fail(message) { throw new Error(`CE-0 evaluation blocked: ${message}`); }
function usageOf(response = {}) { const value = response.usageMetadata || response.usage || {}; return { input: Number(value.promptTokenCount ?? value.inputTokens ?? 0), output: Number(value.candidatesTokenCount ?? value.outputTokens ?? 0) }; }
function cost({ flashInput, flashOutput, transcriptionSeconds }) { return flashInput * FLASH_INPUT_PRICE + flashOutput * FLASH_OUTPUT_PRICE + (transcriptionSeconds / 60) * TRANSCRIBE_PER_MINUTE; }
function json(response, phase) { if (typeof response?.text !== "string" || !response.text.trim()) fail(`${phase} returned no JSON`); try { return JSON.parse(response.text); } catch { fail(`${phase} returned invalid JSON`); } }

/**
 * CE-0 only. The supplied call functions must perform one request exactly once;
 * this module deliberately contains no retry or fallback path.
 */
export async function runCreativeEvaluation({ flash, transcribe, requests, sourceCatalog, evidenceIds, authorizedAssetIds = [], transcriptionSeconds }) {
  if (typeof flash !== "function" || typeof transcribe !== "function") fail("one-shot clients are required");
  if (!Array.isArray(requests) || requests.length !== 4) fail("exactly four Flash requests are required");
  if (!(transcriptionSeconds > 0)) fail("bounded transcription duration is required");
  const usage = { requestCount: 0, flashInput: 0, flashOutput: 0, transcriptionSeconds };
  const outputs = [];
  const charge = () => cost(usage);

  const transcript = await transcribe();
  usage.requestCount += 1;
  if (usage.requestCount > CE0_LIMITS.requests || charge() > CE0_LIMITS.dollars) fail("budget exhausted after transcription");

  for (let index = 0; index < requests.length; index += 1) {
    const outputLimit = CE0_LIMITS.flashOutputByPhase[index];
    const estimate = FLASH_INPUT_ESTIMATES[index];
    if (usage.flashInput + estimate > CE0_LIMITS.flashInputTokens || usage.flashOutput + outputLimit > CE0_LIMITS.flashOutputTokens || charge() + estimate * FLASH_INPUT_PRICE + outputLimit * FLASH_OUTPUT_PRICE > CE0_LIMITS.dollars) fail("next request exceeds CE-0 budget");
    const response = await flash({ ...requests[index], maxOutputTokens: outputLimit, transcript, priorOutputs: outputs });
    usage.requestCount += 1;
    const measured = usageOf(response);
    usage.flashInput += measured.input;
    usage.flashOutput += measured.output;
    if (usage.requestCount > CE0_LIMITS.requests || usage.flashInput > CE0_LIMITS.flashInputTokens || usage.flashOutput > CE0_LIMITS.flashOutputTokens || charge() > CE0_LIMITS.dollars) fail("reported provider usage exceeds CE-0 budget");
    outputs.push(json(response, requests[index].phase));
  }
  const plan = validateCreativeEditingPlan(outputs.at(-1), { sourceCatalog, evidenceIds, authorizedAssetIds });
  return Object.freeze({ plan, usage: Object.freeze({ ...usage, estimatedCostUsd: Number(charge().toFixed(6)) }), intermediateResultsRetained: false });
}

export function createPrivateEvaluationReport({ result }) {
  return Object.freeze({ version: "ce0-evaluation/1", requestCount: result.usage.requestCount, usage: result.usage, creativePlan: result.plan, rawProviderResponsesRetained: false, providerUploadCleanup: "required_finally" });
}

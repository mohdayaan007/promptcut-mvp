import os from "os";
import path from "path";
import { mkdtemp, mkdir, rm, stat as fileStat, writeFile } from "fs/promises";
import { MAX_REFERENCE_VIDEO_BYTES } from "@/lib/jobs/job-config";
import { createExecutionController, EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";
import { extractReferenceVideoTemporalEvidence, buildReferenceVideoVisualEvidence, validateReferenceVideoEvidence } from "@/lib/editor-core/reference-video-understanding";
import { analyzeReferenceVideoWithGemini, prepareReferenceVideoGeminiRequest, REFERENCE_VIDEO_GEMINI_MODEL } from "@/lib/editor-core/reference-video-gemini";
import { validateReferenceVideoFile } from "@/lib/editor-core/reference-video-foundation";
import { validateReferenceVideoCreativeSignature } from "@/lib/editor-core/reference-video-transfer";

const MIME_BY_EXTENSION = Object.freeze({ ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" });

export class ReferenceVideoEvaluationError extends Error {
  constructor(reason, message) { super(message); this.name = "ReferenceVideoEvaluationError"; this.reason = reason; }
}

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new ReferenceVideoEvaluationError("RV3A_INVALID_ARGUMENTS", `${option} requires a value.`);
  return value;
}

/** Developer-only CLI grammar; no positional guessing or implicit live mode. */
export function parseReferenceVideoEvaluationArgs(argv = []) {
  const options = { referencePath: null, originalPath: null, outputDirectory: null, live: false, authorizeLiveGemini: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reference") { options.referencePath = nextValue(argv, index, argument); index += 1; }
    else if (argument === "--original") { options.originalPath = nextValue(argv, index, argument); index += 1; }
    else if (argument === "--output-dir") { options.outputDirectory = nextValue(argv, index, argument); index += 1; }
    else if (argument === "--live") options.live = true;
    else if (argument === "--authorize-live-gemini") options.authorizeLiveGemini = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new ReferenceVideoEvaluationError("RV3A_INVALID_ARGUMENTS", `Unknown evaluation option: ${argument}`);
  }
  if (!options.help && !options.referencePath) throw new ReferenceVideoEvaluationError("RV3A_INVALID_ARGUMENTS", "--reference is required.");
  if (options.live && !options.authorizeLiveGemini) throw new ReferenceVideoEvaluationError("RV3A_LIVE_AUTHORIZATION_REQUIRED", "Live Gemini evaluation requires --live and --authorize-live-gemini.");
  if (!options.live && options.authorizeLiveGemini) throw new ReferenceVideoEvaluationError("RV3A_INVALID_ARGUMENTS", "--authorize-live-gemini requires --live.");
  return Object.freeze(options);
}

export function referenceVideoMimeType(filePath) { return MIME_BY_EXTENSION[path.extname(String(filePath || "")).toLowerCase()] || null; }

function isInsideDirectory(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeCharacteristics(signature) {
  return (signature?.photographic?.characteristics || []).map((entry) => Object.freeze({ field: entry.field, value: entry.value, state: entry.state, sampledFrameCount: entry.sampledFrameCount, coverage: entry.coverage }));
}

function safeSummary({ media, evidence, visualEvidence, preparedRequest, liveResult = null, originalProvided }) {
  const signature = liveResult?.signature;
  const visualDuration = Number(media.videoDuration || media.duration);
  const plannedEndingSample = visualDuration <= 0.1 ? Math.max(0, visualDuration / 2) : Math.max(0.05, visualDuration - 0.05);
  const endingSampleTimestamp = Math.max(...evidence.frames.map((frame) => frame.timestamp));
  return Object.freeze({
    mode: liveResult ? "live" : "dry-run",
    originalProvided: Boolean(originalProvided),
    reference: Object.freeze({ orientation: media.width === media.height ? "square" : media.width > media.height ? "landscape" : "portrait", width: media.width, height: media.height, duration: Number(media.duration.toFixed(3)), videoDuration: Number(visualDuration.toFixed(3)), frameRate: Number(media.frameRate.toFixed(3)), hasAudio: media.hasAudio }),
    temporalEvidence: Object.freeze({ shotCount: evidence.shots.length, sampledFrameCount: evidence.frames.length, visualChangeCandidateCount: evidence.events.filter((event) => event.kind === "visual_change").length, complete: evidence.coverage.complete, reason: evidence.coverage.reason, eventWindowCount: evidence.coverage.eventWindows.length, endingSampleTimestamp, nearEofFallbackUsed: endingSampleTimestamp < plannedEndingSample - 0.001 }),
    request: Object.freeze({ model: REFERENCE_VIDEO_GEMINI_MODEL, imagePartCount: visualEvidence.length, imageBytes: visualEvidence.reduce((total, frame) => total + frame.bytes.length, 0), automaticFunctionCallingDisabled: preparedRequest.config.automaticFunctionCalling.disable, sent: Boolean(liveResult) }),
    interpretation: signature ? Object.freeze({ observationCount: signature.confidence.observationCount, creativeTypographyEstablished: Boolean(signature.typography.opening.length || signature.typography.closing.length || signature.typography.sustained.length || signature.typography.recurring.length), photographicCharacteristics: Object.freeze(safeCharacteristics(signature)), unsupportedCharacteristics: Object.freeze(signature.photographic.sceneSpecific.map((entry) => entry.palette)) }) : Object.freeze({ status: "not_requested", observed: Object.freeze([]), unsupportedCharacteristics: Object.freeze([]) })
  });
}

function assertReadableLocalFile(details, reason) {
  if (!details?.isFile?.() || !Number.isFinite(details.size) || details.size <= 0) throw new ReferenceVideoEvaluationError(reason, "The local evaluation media is unavailable.");
}

async function removeExtractedFrames(evidence, remove = rm) {
  await Promise.all((evidence?.frames || []).map((frame) => remove(frame.imagePath, { force: true }).catch(() => {})));
}

/**
 * Internal local-only RV-3A workflow. Dry mode prepares the exact bounded RV-2B
 * request but never creates a Gemini client or sends media to a provider.
 */
export async function runReferenceVideoEvaluation({ referencePath, originalPath = null, outputDirectory = null, live = false, authorizeLiveGemini = false, environment = process.env, signal, dependencies = {} } = {}) {
  if (!referencePath) throw new ReferenceVideoEvaluationError("RV3A_INVALID_ARGUMENTS", "--reference is required.");
  if (live && !authorizeLiveGemini) throw new ReferenceVideoEvaluationError("RV3A_LIVE_AUTHORIZATION_REQUIRED", "Live Gemini evaluation requires --live and --authorize-live-gemini.");
  if (live && !outputDirectory) throw new ReferenceVideoEvaluationError("RV3A_OUTPUT_REQUIRED", "Live Gemini evaluation requires --output-dir for local review diagnostics.");
  if (live && !String(environment?.GEMINI_API_KEY || "").trim()) throw new ReferenceVideoEvaluationError("RV3A_GEMINI_KEY_REQUIRED", "Live Gemini evaluation requires GEMINI_API_KEY.");
  const statFile = dependencies.statFile || fileStat; const makeTempDirectory = dependencies.mkdtemp || mkdtemp; const makeDirectory = dependencies.mkdir || mkdir; const remove = dependencies.rm || rm;
  const validateReference = dependencies.validateReference || validateReferenceVideoFile; const extractEvidence = dependencies.extractEvidence || extractReferenceVideoTemporalEvidence; const buildVisualEvidence = dependencies.buildVisualEvidence || buildReferenceVideoVisualEvidence; const prepareRequest = dependencies.prepareRequest || prepareReferenceVideoGeminiRequest; const analyze = dependencies.analyze || analyzeReferenceVideoWithGemini;
  const referenceType = referenceVideoMimeType(referencePath);
  if (!referenceType) throw new ReferenceVideoEvaluationError("RV3A_UNSUPPORTED_REFERENCE", "Reference video must be MP4, MOV, WebM, or MKV.");
  const referenceDetails = await statFile(referencePath); assertReadableLocalFile(referenceDetails, "RV3A_REFERENCE_UNAVAILABLE");
  if (referenceDetails.size > MAX_REFERENCE_VIDEO_BYTES) throw new ReferenceVideoEvaluationError("RV3A_REFERENCE_TOO_LARGE", "Reference video must be 250 MB or smaller.");
  if (originalPath) { const originalDetails = await statFile(originalPath); assertReadableLocalFile(originalDetails, "RV3A_ORIGINAL_UNAVAILABLE"); }
  const workspaceRoot = dependencies.workspaceRoot || process.cwd();
  if (outputDirectory && isInsideDirectory(outputDirectory, workspaceRoot)) throw new ReferenceVideoEvaluationError("RV3A_OUTPUT_DIRECTORY_UNSAFE", "Evaluation output must be outside the repository workspace.");
  const temporary = !outputDirectory; const directory = outputDirectory ? path.resolve(outputDirectory) : await makeTempDirectory(path.join(os.tmpdir(), "cliponaut-rv3a-"));
  if (outputDirectory) await makeDirectory(directory, { recursive: true });
  const executionController = createExecutionController(); const abort = () => executionController.cancel(); signal?.addEventListener("abort", abort, { once: true });
  let evidence;
  try {
    const media = await validateReference({ inputPath: referencePath, type: referenceType, executionController });
    evidence = validateReferenceVideoEvidence(await extractEvidence({ inputPath: referencePath, media, scratchDirectory: directory, executionController }));
    const visualEvidence = await buildVisualEvidence({ evidence, signal });
    const preparedRequest = prepareRequest({ frames: visualEvidence, shots: evidence.shots, signal });
    const analyzed = live ? await analyze({ evidence, signal, apiKey: environment.GEMINI_API_KEY }) : null;
    const liveResult = analyzed && Object.freeze({ ...analyzed, signature: validateReferenceVideoCreativeSignature(analyzed.signature) });
    const summary = safeSummary({ media, evidence, visualEvidence, preparedRequest, liveResult, originalProvided: originalPath });
    if (live || outputDirectory) await writeFile(path.join(directory, "rv3a-evaluation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return Object.freeze({ summary, retainedArtifacts: Boolean(live || outputDirectory) });
  } catch (error) {
    await removeExtractedFrames(evidence, remove);
    if (error instanceof ReferenceVideoEvaluationError || error instanceof EditExecutionCancelledError) throw error;
    throw error;
  } finally {
    executionController.dispose(); signal?.removeEventListener("abort", abort);
    if (temporary) await remove(directory, { recursive: true, force: true });
  }
}

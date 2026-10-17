import { mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createAiEditPlan, summarizeStylePlanDiagnostic, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { createExecutionController, EditExecutionCancelledError, executeEditPlan } from "@/lib/editor-core/edit-executor";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { CaptionError, createCaptionCues, extractCaptionCorrection, requestsCaptions } from "@/lib/editor-core/caption-engine";
import { transcribeSource } from "@/lib/editor-core/spoken-transcription";
import { analyzeReferenceStyle, createReferenceStyleDiagnostic, createReferenceStyleFailureDiagnostic, ReferenceStyleError, requestsReferenceStyleMatch } from "@/lib/editor-core/reference-style-matching";
import { extractTargetReferenceFrames, validateReferenceImageFile } from "@/lib/editor-core/reference-style-media";
import { is4kCapableMedia } from "@/lib/media/media-config";
import { MediaProbeError, probeVideoFile } from "@/lib/media/media-probe";
import { jobConfig } from "@/lib/jobs/job-config";
import {
  claimNextJob, completeJob, expireUploadJob, failJob, getAbandonedUploads, getJobsForCleanup, heartbeatJob, isJobCancelled, markOutputCleaned,
  markSourcesCleaned, recoverStaleJobs, setJobStatus
} from "@/lib/jobs/job-store";
import { abortMultipartUpload, deleteObjects, downloadObject, outputObjectKey, uploadOutput } from "@/lib/jobs/storage";

const config = jobConfig();
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;
let lastCleanup = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) {
  if (error instanceof MediaProbeError) return error.message;
  if (error instanceof UnsupportedEditRequestError) return error.message;
  if (/4K export requires every uploaded video to be 4K-capable/.test(error?.message)) return error.message;
  if (error instanceof CaptionError) {
    if (error.message === "CAPTION_CORRECTION_AMBIGUOUS") return "The subtitle correction matches more than one caption.";
    if (error.message === "CAPTION_CORRECTION_NO_MATCH") return "I couldn't find that subtitle text to replace.";
    return "This video has no usable speech for subtitles.";
  }
  if (error instanceof ReferenceStyleError) {
    if (error.reason === "REFERENCE_SAFETY_REJECTED") return "This reference can’t be used for style matching. Please choose another image or video.";
    if (error.reason === "REFERENCE_TARGET_HETEROGENEOUS") return "This first version works best with visually coherent footage. Please choose another video.";
    if (["REFERENCE_TARGET_COUNT", "REFERENCE_COMPATIBILITY_WEAK"].includes(error.reason)) return error.message;
    return "This reference image could not be used safely.";
  }
  return "Unable to process this video. Please try again.";
}
class JobCancelledError extends Error {}
async function throwIfCancelled(jobId) {
  if (await isJobCancelled(jobId, workerId)) throw new JobCancelledError();
}

async function cleanExpiredObjects() {
  const abandonedUploads = await getAbandonedUploads(config.sourceRetentionHours);
  for (const job of abandonedUploads) {
    await Promise.all([...job.sources, ...(job.reference ? [job.reference] : [])].map((source) => abortMultipartUpload(source).catch(() => {})));
    await expireUploadJob(job.id).catch(() => {});
  }
  const jobs = await getJobsForCleanup(config);
  for (const job of jobs) {
    if (!job.sourceCleanedAt && ["completed", "failed", "cancelled"].includes(job.status)) {
      await deleteObjects([...job.sources.map((source) => source.key), job.reference?.key]);
      await markSourcesCleaned(job.id);
    }
    if (!job.outputCleanedAt && job.status === "completed" && job.outputKey) {
      await deleteObjects([job.outputKey]);
      await markOutputCleaned(job.id);
    }
  }
}

async function processJob(job) {
  let scratch;
  let heartbeat;
  let cancellationMonitor;
  let executionController;
  let outputKey;
  try {
    await mkdir(config.scratchDirectory, { recursive: true });
    scratch = await mkdtemp(path.join(config.scratchDirectory, `${job.id}-`));
    heartbeat = setInterval(() => heartbeatJob(job.id, workerId).catch(() => {}), 30_000);
    executionController = createExecutionController();
    const cancelExecutionIfNeeded = async () => {
      if (await isJobCancelled(job.id, workerId)) executionController.cancel();
    };
    await cancelExecutionIfNeeded();
    cancellationMonitor = setInterval(() => cancelExecutionIfNeeded().catch(() => {}), 1_000);
    const sources = [...job.sources].sort((left, right) => left.index - right.index);
    const inputPaths = [];
    for (const source of sources) {
      const inputPath = path.join(scratch, `source-${source.index}.mp4`);
      await downloadObject(source.key, inputPath);
      inputPaths.push(inputPath);
    }
    const media = [];
    for (const inputPath of inputPaths) media.push(await probeVideoFile(inputPath));
    const sourceCatalog = createSourceCatalog(sources, media);
    await throwIfCancelled(job.id);
    if (job.exportQuality === "4k" && !media.every(is4kCapableMedia)) {
      throw new Error("4K export requires every uploaded video to be 4K-capable");
    }
    let referenceTreatment = null;
    if (job.reference && requestsReferenceStyleMatch(job.prompt, true)) {
      if (sources.length !== 1) throw new ReferenceStyleError("REFERENCE_TARGET_COUNT", "Reference style matching currently supports one target video.");
      const extension = job.reference.type === "image/png" ? "png" : job.reference.type === "image/webp" ? "webp" : "jpg";
      const referencePath = path.join(scratch, `reference.${extension}`);
      await downloadObject(job.reference.key, referencePath);
      await validateReferenceImageFile({ inputPath: referencePath, type: job.reference.type, executionController });
      const samples = await extractTargetReferenceFrames({ inputPath: inputPaths[0], duration: media[0].duration, scratchDirectory: scratch, executionController });
      const result = await analyzeReferenceStyle({ referencePath, referenceMimeType: job.reference.type, targetFrames: samples.frames, metrics: samples.metrics });
      referenceTreatment = result.treatment;
      console.info("Reference style treatment prepared:", {
        frameCount: samples.frames.length,
        ...createReferenceStyleDiagnostic({ jobId: job.id, analysis: result.analysis, metrics: samples.metrics, treatment: referenceTreatment })
      });
    }
    let planning;
    try {
      planning = await createAiEditPlan({
        inputPath: inputPaths[0], inputMimeType: sources[0].type,
        sourceInputs: sources.map((source) => ({ inputPath: inputPaths[source.index], inputMimeType: source.type, source: sourceCatalog.find((entry) => entry.index === source.index) })),
        prompt: job.prompt, hasMultipleVideos: inputPaths.length > 1, sourceCatalog, scratchDirectory: scratch, executionController,
        referenceStyleActive: Boolean(referenceTreatment)
      });
    } catch (error) {
      // A reference-only phrase ("make my video look like this") has no
      // ordinary editor operation. The server-owned B2 operation is sufficient;
      // unrelated unsupported requests still retain normal planner behavior.
      // Only an otherwise empty ordinary plan may fall back to the B2-only
      // treatment. Deliberate reference + named-style conflicts must remain a
      // safe rejection instead of being silently stacked by the fallback.
      if (!referenceTreatment || !(error instanceof UnsupportedEditRequestError) || error.message !== "This edit is not supported yet") throw error;
      planning = { plan: createEditPlan({ prompt: job.prompt, hasMultipleVideos: false, sourceCatalog }), source: "reference_style" };
    }
    const plan = planning.plan;
    if (referenceTreatment && plan.referenceStyleReconciliation?.suppressedVisualOperationTypes.length) {
      console.info("Reference style planner visual operations suppressed:", {
        jobId: job.id,
        suppressedVisualOperationTypes: plan.referenceStyleReconciliation.suppressedVisualOperationTypes
      });
    }
    if (referenceTreatment) plan.operations = [...plan.operations, { type: "reference_style_treatment", treatment: referenceTreatment }];
    if (requestsCaptions(job.prompt) && !plan.operations.some((operation) => operation.type === "captions")) plan.operations.push({ type: "captions" });
    const editPlan = validateEditPlan(plan, { sourceCatalog });
    const stylePlanDiagnostic = summarizeStylePlanDiagnostic(planning, editPlan);
    if (stylePlanDiagnostic) console.info("Cliponaut style plan diagnostic:", { jobId: job.id, ...stylePlanDiagnostic });
    const captionOperation = editPlan.operations.find((operation) => operation.type === "captions");
    let captionCues = [];
    if (captionOperation) {
      const transcripts = planning.transcripts || new Map();
      const sequence = editPlan.operations.find((operation) => operation.type === "sequence");
      const captionSourceIds = sequence ? [...new Set(sequence.clips.map((clip) => clip.sourceId))] : sourceCatalog.map((source) => source.sourceId);
      for (const sourceId of captionSourceIds) {
        const source = sourceCatalog.find((entry) => entry.sourceId === sourceId);
        if (!source?.hasAudio) continue;
        let transcript = transcripts.get(sourceId);
        if (!transcript) {
          transcript = await transcribeSource({ inputPath: inputPaths[source.index], scratchDirectory: scratch, sourceId, duration: source.duration, executionController });
          transcripts.set(sourceId, transcript);
        }
        captionCues.push(...createCaptionCues(transcript));
      }
      if (!captionCues.length) throw new CaptionError("CAPTION_NO_USABLE_SPEECH");
    }
    const captionCorrection = captionOperation ? extractCaptionCorrection(job.prompt) : null;
    await throwIfCancelled(job.id);
    if (!await setJobStatus(job.id, workerId, "rendering")) throw new JobCancelledError();
    const outputPath = await executeEditPlan({ inputPaths, media, plan: editPlan, sourceCatalog, tempDirectory: scratch, exportQuality: job.exportQuality, executionController, captionCues, captionCorrection, jobId: job.id });
    await throwIfCancelled(job.id);
    outputKey = outputObjectKey(job.id);
    await uploadOutput(outputKey, outputPath);
    await throwIfCancelled(job.id);
    if (!await completeJob(job.id, workerId, outputKey)) {
      await deleteObjects([outputKey]);
    }
  } catch (error) {
    if (error instanceof JobCancelledError || error instanceof EditExecutionCancelledError) {
      if (outputKey) await deleteObjects([outputKey]).catch(() => {});
      return;
    }
    if (error instanceof ReferenceStyleError) {
      console.error("Reference style analysis failed:", createReferenceStyleFailureDiagnostic({ jobId: job.id, error }));
    } else {
      console.error(`Job ${job.id} failed:`, error.message);
    }
    await failJob(job.id, workerId, safeError(error)).catch(() => {});
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancellationMonitor) clearInterval(cancellationMonitor);
    executionController?.dispose();
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function run() {
  if (config.workerConcurrency !== 1) throw new Error("Only one worker process is supported initially; set JOB_WORKER_CONCURRENCY=1");
  console.log(`Cliponaut worker ${workerId} started.`);
  while (!stopping) {
    try {
      await recoverStaleJobs(config);
      if (Date.now() - lastCleanup > 60 * 60 * 1_000) {
        await cleanExpiredObjects();
        lastCleanup = Date.now();
      }
      const job = await claimNextJob(workerId);
      if (job) await processJob(job);
      else await sleep(config.pollIntervalMs);
    } catch (error) {
      console.error("Worker polling failed:", error.message);
      await sleep(config.pollIntervalMs);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
run().catch((error) => { console.error("Worker could not start:", error.message); process.exitCode = 1; });

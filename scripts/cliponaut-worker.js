import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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
import { analyzeReferenceStyle, createReferenceStyleDiagnostic, createReferenceStyleFailureDiagnostic, evaluateReferenceStyleProxy, isB2aProxyRefinementEnabled, refineReferenceStyleTreatment, ReferenceStyleError, requestsReferenceStyleMatch } from "@/lib/editor-core/reference-style-matching";
import { createReferenceStyleProxyFrames, extractReferenceVideoFrames, extractTargetReferenceFrames, validateReferenceImageFile, validateReferenceVideoFile } from "@/lib/editor-core/reference-style-media";
import { analyzeTypographyReference, extractTypographyReferenceSelector, reconcileTypographyReferenceTitlePlan, requestsTypographyReferenceMatch, TypographyReferenceError } from "@/lib/editor-core/typography-reference-matching";
import { parseTitle } from "@/lib/title-parser";
import { is4kCapableMedia } from "@/lib/media/media-config";
import { MediaProbeError, probeVideoFile } from "@/lib/media/media-probe";
import { jobConfig } from "@/lib/jobs/job-config";
import { hasApprovedReferenceVideoSafety } from "@/lib/jobs/reference-video-safety";
import {
  claimNextJob, completeJob, expireUploadJob, failJob, getAbandonedUploads, getJobsForCleanup, heartbeatJob, isFounderSubscriber, isJobCancelled, markOutputCleaned,
  markSourcesCleaned, recoverStaleJobs, saveJobPlan, setJobStatus, syncVersionStatus, leaseDueCancellationRecoveryCases, recordCancellationRecoveryEvidence
} from "@/lib/jobs/job-store";
import { cancellationRecoveryEnabled, getDodoTestCancellationState } from "@/lib/dodo-test-mode";
import { createCancellationRecoveryMaintenance } from "@/lib/cancellation-recovery-maintenance";
import { abortMultipartUpload, deleteObjects, downloadObject, outputObjectKey, uploadOutput } from "@/lib/jobs/storage";
import { customerMklRuntimeConfig } from "@/lib/editor-core/prepared-mkl-runtime";
import { renderCustomerMkl } from "@/lib/editor-core/founder-mkl-local";
import { applyTypographyV1aToPlan, assertFounderTypographyV1a, validateTypographyV1a } from "@/lib/editor-core/typography-v1a";
import { applyEvidenceSelection, isConversationAgentEnvelope } from "@/lib/editor-core/conversation-agent";
import { runBoundedEditingAgent } from "@/lib/editor-core/bounded-editing-agent";
import { createUgcDirectorPlan, isUgcDirectorRequest } from "@/lib/editor-core/ugc-director";

const config = jobConfig();
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;
let lastCleanup = 0;
let lastCancellationRecovery = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function customerMklEnabled(founderAuthorized = false) { try { customerMklRuntimeConfig({ founderAuthorized }); return true; } catch { return false; } }
function safeError(error) {
  if (error instanceof MediaProbeError) return error.message;
  if (error instanceof UnsupportedEditRequestError) return error.message;
  if (error?.message === "Add a title in your request to use the selected export font") return error.message;
  if (error?.message === "Typography V1A is not enabled for this account") return "Typography V1A is not enabled for this account.";
  if (/4K export requires every uploaded video to be 4K-capable/.test(error?.message)) return error.message;
  if (error instanceof CaptionError) {
    if (error.message === "CAPTION_CORRECTION_AMBIGUOUS") return "The subtitle correction matches more than one caption.";
    if (error.message === "CAPTION_CORRECTION_NO_MATCH") return "I couldn't find that subtitle text to replace.";
    return "This video has no usable speech for subtitles.";
  }
  if (error instanceof ReferenceStyleError) {
    if (error.reason === "REFERENCE_SAFETY_REJECTED") return "This reference can’t be used for style matching. Please choose another image or video.";
    if (error.reason === "REFERENCE_VIDEO_SAFETY_REQUIRED") return "This reference video needs dedicated safety screening before it can be processed.";
    if (error.reason === "REFERENCE_INVALID_VIDEO") return "This reference video could not be verified. Use a video under 60 seconds at 1080p or smaller.";
    if (error.reason === "REFERENCE_TARGET_HETEROGENEOUS") return "This first version works best with visually coherent footage. Please choose another video.";
    if (["REFERENCE_TARGET_COUNT", "REFERENCE_COMPATIBILITY_WEAK"].includes(error.reason)) return error.message;
    return "This reference image could not be used safely.";
  }
  if (error instanceof TypographyReferenceError) {
    if (error.reason === "TYPOGRAPHY_REFERENCE_SAFETY_REJECTED") return "This reference can’t be used for style matching. Please choose another image or video.";
    if (error.reason === "TYPOGRAPHY_REFERENCE_AMBIGUOUS") return "This reference has more than one typography style. Please choose a clearer reference.";
    if (error.reason === "TYPOGRAPHY_REFERENCE_NO_TEXT") return "This reference doesn’t contain a clear typography style.";
    if (error.reason === "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH") return "I couldn’t identify that typography in the reference.";
    if (error.reason === "TYPOGRAPHY_TITLE_REQUIRED") return "Add a title in your request to use a typography reference.";
    return "This reference image could not be used safely.";
  }
  return "Unable to process this video. Please try again.";
}
class JobCancelledError extends Error {}
async function prepareReferenceStyleMedia({ reference, scratch, executionController }) {
  if (reference?.kind !== "video") {
    const extension = reference.type === "image/png" ? "png" : reference.type === "image/webp" ? "webp" : "jpg";
    const referencePath = path.join(scratch, `reference.${extension}`);
    await downloadObject(reference.key, referencePath);
    await validateReferenceImageFile({ inputPath: referencePath, type: reference.type, executionController });
    return { referencePath, referenceMimeType: reference.type, evidence: null };
  }
  // A generic moderation signal, MIME validation, or a "minor" classifier is
  // never accepted as CSAM screening. Public video jobs need dedicated,
  // server-owned coverage before any frames can reach analysis or rendering.
  if (!hasApprovedReferenceVideoSafety(reference)) throw new ReferenceStyleError("REFERENCE_VIDEO_SAFETY_REQUIRED", "This reference video cannot be processed until dedicated safety screening is available.");
  const referencePath = path.join(scratch, "reference-video");
  await downloadObject(reference.key, referencePath);
  const media = await validateReferenceVideoFile({ inputPath: referencePath, type: reference.type, executionController });
  const frames = await extractReferenceVideoFrames({ inputPath: referencePath, media, scratchDirectory: path.join(scratch, "reference-video-frames"), executionController });
  return { referencePath: frames[0].imagePath, referenceMimeType: "image/jpeg", evidence: { kind: "video_frames", frameCount: frames.length, frameEvidenceIds: frames.map((frame) => frame.evidenceId) } };
}
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
async function reconcileCancellationRecoveryCases() {
  if (!cancellationRecoveryEnabled() || stopping) return;
  for (const recovery of await leaseDueCancellationRecoveryCases()) {
    try {
      const provider = await getDodoTestCancellationState({ subscriptionId: recovery.subscription_id });
      // Subscription GET intentionally has no verified business provenance in
      // the current SDK schema. It informs the audit/retry schedule only; a
      // fully pinned signed webhook performs authoritative confirmation.
      await recordCancellationRecoveryEvidence(recovery.id, recovery.leaseToken, { confirmed: false, source: provider.evidenceSource, businessProvenance: provider.businessProvenance });
    } catch { await recordCancellationRecoveryEvidence(recovery.id, recovery.leaseToken, { confirmed: false }).catch(() => {}); }
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
    let mklReferencePath = null;
    let typographyTreatment = null;
    const typographyV1a = validateTypographyV1a(job.typographyV1a);
    // This is deliberately independent of the web gate. A queued job is not
    // trusted merely because it contains a marker: re-check its persisted
    // subscriber identity at execution time.
    if (typographyV1a) {
      const founderAuthorizedForTypography = Boolean(job.subscriberId && await isFounderSubscriber(job.subscriberId));
      assertFounderTypographyV1a({ founderAuthorized: founderAuthorizedForTypography });
    }
    const founderAuthorizedForMkl = Boolean(
      job.reference?.kind === "video_profile" && job.subscriberId &&
      await isFounderSubscriber(job.subscriberId)
    );
    const typographyReferenceActive = Boolean(job.reference && requestsTypographyReferenceMatch(job.prompt, true));
    if (typographyReferenceActive) {
      if (sources.length !== 1) throw new TypographyReferenceError("TYPOGRAPHY_TARGET_COUNT");
      const { referencePath, referenceMimeType } = await prepareReferenceStyleMedia({ reference: job.reference, scratch, executionController });
      const selector = extractTypographyReferenceSelector(job.prompt);
      let result;
      try {
        result = await analyzeTypographyReference({ referencePath, referenceMimeType, selector });
      } catch (error) {
        if (error instanceof TypographyReferenceError && error.selectionDiagnostic) {
          console.info("Typography reference selection rejected:", { jobId: job.id, reason: error.reason, ...error.selectionDiagnostic });
        }
        throw error;
      }
      typographyTreatment = result.treatment;
      console.info("Typography reference treatment prepared:", {
        jobId: job.id,
        font: typographyTreatment.font,
        weight: typographyTreatment.weight,
        size: typographyTreatment.size,
        color: typographyTreatment.color,
        position: typographyTreatment.position,
        selectedCandidateId: typographyTreatment.selectedCandidateId
      });
    } else if (job.reference && requestsReferenceStyleMatch(job.prompt, true) && customerMklEnabled(founderAuthorizedForMkl) && ["video", "video_profile"].includes(job.reference.kind)) {
      if (sources.length !== 1) throw new ReferenceStyleError("REFERENCE_TARGET_COUNT", "Reference style matching currently supports one target video.");
      if (job.reference.kind === "video") {
        if (!hasApprovedReferenceVideoSafety(job.reference)) throw new ReferenceStyleError("REFERENCE_VIDEO_SAFETY_REQUIRED", "This reference video cannot be processed until dedicated safety screening is available.");
        mklReferencePath = path.join(scratch, "customer-mkl-reference"); await downloadObject(job.reference.key, mklReferencePath); await validateReferenceVideoFile({ inputPath: mklReferencePath, type: job.reference.type, executionController });
      } else { mklReferencePath = path.join(scratch, "customer-mkl-profile.json"); await writeFile(mklReferencePath, JSON.stringify(job.reference.profile), { mode: 0o600 }); }
    } else if (job.reference && requestsReferenceStyleMatch(job.prompt, true)) {
      if (sources.length !== 1) throw new ReferenceStyleError("REFERENCE_TARGET_COUNT", "Reference style matching currently supports one target video.");
      const { referencePath, referenceMimeType } = await prepareReferenceStyleMedia({ reference: job.reference, scratch, executionController });
      const samples = await extractTargetReferenceFrames({ inputPath: inputPaths[0], duration: media[0].duration, scratchDirectory: scratch, executionController });
      const result = await analyzeReferenceStyle({ referencePath, referenceMimeType, targetFrames: samples.frames, metrics: samples.metrics });
      referenceTreatment = result.treatment;
      if (isB2aProxyRefinementEnabled()) {
        try {
        executionController.throwIfCancelled();
        const proxy = await createReferenceStyleProxyFrames({ targetFrames: samples.frames, treatment: referenceTreatment, scratchDirectory: scratch, executionController });
        const evaluation = await evaluateReferenceStyleProxy({ referencePath, referenceMimeType, proxyFrames: proxy.frames, metrics: proxy.metrics, executionController });
        executionController.throwIfCancelled();
        const refinement = refineReferenceStyleTreatment({ initialTreatment: referenceTreatment, analysis: result.analysis, metrics: proxy.metrics, evaluation });
        referenceTreatment = refinement.treatment;
        console.info("Reference style proxy refinement:", {
          jobId: job.id, initialRecipe: result.treatment.recipe, proxyFrameCount: proxy.frames.length, proxyMetrics: proxy.metrics,
          residual: evaluation.available ? evaluation.evaluation : null, refinementApplied: refinement.applied,
          reason: refinement.reason, finalRecipe: referenceTreatment.recipe
        });
        } catch (error) {
          if (error instanceof EditExecutionCancelledError) throw error;
          console.info("Reference style proxy refinement skipped:", { jobId: job.id, reason: "proxy_generation_unavailable", finalRecipe: referenceTreatment.recipe });
        }
      }
      console.info("Reference style treatment prepared:", {
        frameCount: samples.frames.length,
        ...createReferenceStyleDiagnostic({ jobId: job.id, analysis: result.analysis, metrics: samples.metrics, treatment: referenceTreatment })
      });
    }
    let planning;
    if (mklReferencePath) {
      planning = { plan: createEditPlan({ prompt: "Apply approved MKL reference colour treatment.", hasMultipleVideos: false, sourceCatalog }), source: "customer_mkl" };
    } else if (isUgcDirectorRequest(job.prompt)) {
      // The existing planner/localizers remain the only evidence provider. A
      // Director policy may compose only the server-validated selected clips.
      const evidence = await createAiEditPlan({
        inputPath: inputPaths[0], inputMimeType: sources[0].type,
        sourceInputs: sources.map((source) => ({ inputPath: inputPaths[source.index], inputMimeType: source.type, source: sourceCatalog.find((entry) => entry.index === source.index) })),
        prompt: job.prompt, hasMultipleVideos: inputPaths.length > 1, sourceCatalog, scratchDirectory: scratch, executionController,
        referenceStyleActive: Boolean(referenceTreatment)
      });
      const sequence = evidence.plan.operations?.find((operation) => operation.type === "sequence");
      if (!sequence?.clips?.length) throw new UnsupportedEditRequestError("I couldn’t verify product footage for an AI Director edit.");
      planning = { plan: createUgcDirectorPlan({ sourceCatalog, evidence: { productClips: sequence.clips }, prompt: job.prompt }), source: "ugc_director", transcripts: evidence.transcripts };
    } else if (isConversationAgentEnvelope(job.editPlan)) {
      let evidence;
      const agent = await runBoundedEditingAgent({
        context: { request: job.editPlan.prompt, revisionCount: job.editPlan.revisionHistory.length, sourceCount: sourceCatalog.length },
        executionController,
        adapter: async ({ observations }) => observations.length === 0
          ? { tool: "inspect_project", input: {} }
          : observations.length === 1
            ? { tool: "inspect_media_evidence", input: { request: job.editPlan.prompt } }
            : { tool: "submit_plan", input: {} },
        tools: {
          inspect_project: async () => ({ sourceCatalog: sourceCatalog.map(({ sourceId, duration, width, height, hasAudio }) => ({ sourceId, duration, width, height, hasAudio })), visiblePlan: job.editPlan.priorPlan }),
          inspect_media_evidence: async ({ request }) => {
            if (request !== job.editPlan.prompt) throw new Error("Conversation evidence request mismatch");
            evidence = await createAiEditPlan({
              inputPath: inputPaths[0], inputMimeType: sources[0].type,
              sourceInputs: sources.map((source) => ({ inputPath: inputPaths[source.index], inputMimeType: source.type, source: sourceCatalog.find((entry) => entry.index === source.index) })),
              prompt: request, hasMultipleVideos: inputPaths.length > 1, sourceCatalog, scratchDirectory: scratch, executionController,
              referenceStyleActive: Boolean(referenceTreatment)
            });
            return { evidenceAvailable: Boolean(evidence?.plan?.operations?.length) };
          },
          submit_plan: async () => {
            if (!evidence?.plan) throw new Error("Conversation evidence was unavailable");
            return applyEvidenceSelection({ envelope: job.editPlan, evidencePlan: evidence.plan, sourceCatalog });
          }
        }
      });
      planning = { plan: agent.plan, source: "conversation_evidence_agent", transcripts: evidence?.transcripts };
    } else if (job.editPlan) {
      planning = { plan: job.editPlan, source: "conversation" };
    } else try {
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
      if ((!referenceTreatment && !typographyTreatment) || !(error instanceof UnsupportedEditRequestError) || error.message !== "This edit is not supported yet") throw error;
      planning = { plan: createEditPlan({ prompt: job.prompt, hasMultipleVideos: false, sourceCatalog }), source: typographyTreatment ? "typography_reference" : "reference_style" };
    }
    let plan = planning.plan;
    if (referenceTreatment && plan.referenceStyleReconciliation?.suppressedVisualOperationTypes.length) {
      console.info("Reference style planner visual operations suppressed:", {
        jobId: job.id,
        suppressedVisualOperationTypes: plan.referenceStyleReconciliation.suppressedVisualOperationTypes
      });
    }
    if (referenceTreatment) plan.operations = [...plan.operations, { type: "reference_style_treatment", treatment: referenceTreatment }];
    if (typographyTreatment) plan = reconcileTypographyReferenceTitlePlan(plan, parseTitle(job.prompt, { stripQuotedText: true }), typographyTreatment);
    if (typographyV1a) plan = applyTypographyV1aToPlan(plan, typographyV1a);
    if (requestsCaptions(job.prompt) && !plan.operations.some((operation) => operation.type === "captions")) plan.operations.push({ type: "captions" });
    const editPlan = validateEditPlan(plan, { sourceCatalog });
    await saveJobPlan(job.id, workerId, editPlan, sourceCatalog);
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
    await syncVersionStatus(job.id, "rendering");
    const outputPath = mklReferencePath
      ? (await renderCustomerMkl({ sourcePath: inputPaths[0], ...(job.reference.kind === "video_profile" ? { referenceProfilePath: mklReferencePath } : { referencePath: mklReferencePath }), outputPath: path.join(scratch, "customer-mkl.mp4"), reportPath: path.join(scratch, "customer-mkl-report.json"), executionController, founderAuthorized: founderAuthorizedForMkl }), path.join(scratch, "customer-mkl.mp4"))
      : await executeEditPlan({ inputPaths, media, plan: editPlan, sourceCatalog, tempDirectory: scratch, exportQuality: job.exportQuality, executionController, captionCues, captionCorrection, jobId: job.id });
    await throwIfCancelled(job.id);
    outputKey = outputObjectKey(job.id);
    await uploadOutput(outputKey, outputPath);
    await throwIfCancelled(job.id);
    if (!await completeJob(job.id, workerId, outputKey)) {
      await deleteObjects([outputKey]);
    } else await syncVersionStatus(job.id, "completed");
  } catch (error) {
    if (error instanceof JobCancelledError || error instanceof EditExecutionCancelledError) {
      if (outputKey) await deleteObjects([outputKey]).catch(() => {});
      await syncVersionStatus(job.id, "cancelled").catch(() => {});
      return;
    }
    if (error instanceof ReferenceStyleError) {
      console.error("Reference style analysis failed:", createReferenceStyleFailureDiagnostic({ jobId: job.id, error }));
    } else {
      console.error(`Job ${job.id} failed:`, error.message);
    }
    await failJob(job.id, workerId, safeError(error)).catch(() => {});
    await syncVersionStatus(job.id, "failed").catch(() => {});
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
  const recoveryMaintenance = createCancellationRecoveryMaintenance({ enabled: cancellationRecoveryEnabled, reconcile: reconcileCancellationRecoveryCases, onError: (error) => console.error("Cancellation recovery maintenance failed:", error.message) });
  const recoveryTimer = recoveryMaintenance.start(); recoveryTimer.unref?.();
  while (!stopping) {
    try {
      await recoverStaleJobs(config);
      if (Date.now() - lastCancellationRecovery > 60_000) { recoveryMaintenance.tick(); lastCancellationRecovery = Date.now(); }
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
  recoveryMaintenance.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
run().catch((error) => { console.error("Worker could not start:", error.message); process.exitCode = 1; });

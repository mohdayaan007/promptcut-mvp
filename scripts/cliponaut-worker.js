import { mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createAiEditPlan, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import { executeEditPlan } from "@/lib/editor-core/edit-executor";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
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
  return "Unable to process this video. Please try again.";
}
class JobCancelledError extends Error {}
async function throwIfCancelled(jobId) {
  if (await isJobCancelled(jobId, workerId)) throw new JobCancelledError();
}

async function cleanExpiredObjects() {
  const abandonedUploads = await getAbandonedUploads(config.sourceRetentionHours);
  for (const job of abandonedUploads) {
    await Promise.all(job.sources.map((source) => abortMultipartUpload(source).catch(() => {})));
    await expireUploadJob(job.id).catch(() => {});
  }
  const jobs = await getJobsForCleanup(config);
  for (const job of jobs) {
    if (!job.sourceCleanedAt && ["completed", "failed", "cancelled"].includes(job.status)) {
      await deleteObjects(job.sources.map((source) => source.key));
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
  let outputKey;
  try {
    await mkdir(config.scratchDirectory, { recursive: true });
    scratch = await mkdtemp(path.join(config.scratchDirectory, `${job.id}-`));
    heartbeat = setInterval(() => heartbeatJob(job.id, workerId).catch(() => {}), 30_000);
    const inputPaths = [];
    for (const source of job.sources) {
      const inputPath = path.join(scratch, `source-${source.index}.mp4`);
      await downloadObject(source.key, inputPath);
      inputPaths.push(inputPath);
    }
    const media = [];
    for (const inputPath of inputPaths) media.push(await probeVideoFile(inputPath));
    await throwIfCancelled(job.id);
    if (job.exportQuality === "4k" && !media.every(is4kCapableMedia)) {
      throw new Error("4K export requires every uploaded video to be 4K-capable");
    }
    const { plan } = await createAiEditPlan({
      inputPath: inputPaths[0], inputMimeType: job.sources[0].type, prompt: job.prompt,
      hasMultipleVideos: inputPaths.length > 1
    });
    const editPlan = validateEditPlan(plan);
    await throwIfCancelled(job.id);
    if (!await setJobStatus(job.id, workerId, "rendering")) throw new JobCancelledError();
    const outputPath = await executeEditPlan({ inputPaths, media, plan: editPlan, tempDirectory: scratch, exportQuality: job.exportQuality });
    await throwIfCancelled(job.id);
    outputKey = outputObjectKey(job.id);
    await uploadOutput(outputKey, outputPath);
    await throwIfCancelled(job.id);
    if (!await completeJob(job.id, workerId, outputKey)) {
      await deleteObjects([outputKey]);
    }
  } catch (error) {
    if (error instanceof JobCancelledError) {
      if (outputKey) await deleteObjects([outputKey]).catch(() => {});
      return;
    }
    console.error(`Job ${job.id} failed:`, error.message);
    await failJob(job.id, workerId, safeError(error)).catch(() => {});
  } finally {
    if (heartbeat) clearInterval(heartbeat);
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

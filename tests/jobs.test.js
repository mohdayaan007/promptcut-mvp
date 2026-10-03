import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MAX_DIRECT_UPLOAD_FILE_BYTES, JOB_STATUSES, validateJobRequest, validateUploadManifest } from "@/lib/jobs/job-config";
import { buildNormalizationFilter, createMediaProfile } from "@/lib/editor-core/media-profile";
import { DIRECT_UPLOAD_CORS } from "@/lib/jobs/storage";
import { safeSourceMetadata } from "@/lib/jobs/http";
import { ACTIVE_JOB_STATUSES, isActiveJobStatus, isRecoverableJobStatus } from "@/lib/client/direct-upload";
import { EDIT_JOBS_SCHEMA } from "@/lib/jobs/job-store";
import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { createEditPlanJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { createAiEditPlan } from "@/lib/editor-core/ai-editor/planner";
import { buildAiEditorPrompt } from "@/lib/editor-core/ai-editor/prompt";
import { requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { createExecutionController, EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

const video = { name: "source.mp4", type: "video/mp4", size: 1024 };
const sourceCatalog = createSourceCatalog(
  [
    { ...video, index: 0, name: "A.mp4" },
    { ...video, index: 1, name: "B.mp4" },
    { ...video, index: 2, name: "C.mp4" }
  ],
  [
    { duration: 20, width: 1920, height: 1080 },
    { duration: 30, width: 1280, height: 720 },
    { duration: 40, width: 1080, height: 1920 }
  ]
);

function plannerSources(catalog = sourceCatalog) {
  return catalog.map((source) => ({ inputPath: `/tmp/${source.sourceId}.mp4`, inputMimeType: "video/mp4", source }));
}

function createMockGemini({ responseText, failures = [] } = {}) {
  const uploads = [];
  const deletes = [];
  const requests = [];
  let generateCalls = 0;
  return {
    uploads, deletes, requests,
    files: {
      upload: async ({ file }) => {
        const uploaded = { name: `files/${uploads.length + 1}`, uri: `gemini://${file}`, mimeType: "video/mp4", state: "ACTIVE" };
        uploads.push(uploaded);
        return uploaded;
      },
      get: async ({ name }) => uploads.find((file) => file.name === name),
      delete: async ({ name }) => { deletes.push(name); }
    },
    models: {
      generateContent: async (request) => {
        requests.push(request);
        const failure = failures[generateCalls++];
        if (failure) throw failure;
        return { text: responseText };
      }
    }
  };
}

async function withGeminiKey(callback) {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try { return await callback(); } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
}

function createMockChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

test("direct-upload manifest accepts five bounded video files", () => {
  assert.equal(validateUploadManifest(Array.from({ length: 5 }, (_, index) => ({ ...video, name: `${index}.mp4` }))), 5120);
});

test("direct-upload manifest rejects over-limit source files", () => {
  assert.throws(() => validateUploadManifest([{ ...video, size: MAX_DIRECT_UPLOAD_FILE_BYTES + 1 }]), /5 GB/);
});

test("job request needs a prompt and a supported export quality", () => {
  assert.throws(() => validateJobRequest({ prompt: "", exportQuality: "standard", sources: [video] }), /Describe/);
  assert.throws(() => validateJobRequest({ prompt: "Black and white", exportQuality: "8k", sources: [video] }), /exportQuality/);
});

test("same-orientation mixed sources fill the common canvas", () => {
  const profile = createMediaProfile({ media: [{ width: 3840, height: 2160 }, { width: 1280, height: 720 }], exportQuality: "standard" });
  assert.match(buildNormalizationFilter(profile, { width: 1280, height: 720 }), /force_original_aspect_ratio=increase,crop=/);
});

test("direct upload CORS permits only Cliponaut and local development", () => {
  const [rule] = DIRECT_UPLOAD_CORS.CORSRules;
  assert.deepEqual(rule.AllowedOrigins, ["https://cliponaut.com", "http://localhost:3000"]);
  assert.deepEqual(rule.AllowedMethods, ["GET", "HEAD", "PUT"]);
  assert.deepEqual(rule.ExposeHeaders, ["ETag"]);
});

test("restored source metadata preserves order without storage keys", () => {
  const sources = safeSourceMetadata([
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500, key: "private/fifth" },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200, key: "private/second" },
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100, key: "private/first" },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400, key: "private/fourth" },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300, key: "private/third" }
  ]);
  assert.deepEqual(sources, [
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100 },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200 },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300 },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400 },
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500 }
  ]);
});

test("cancelled is a terminal durable-job status and is eligible for source cleanup", () => {
  assert.ok(JOB_STATUSES.includes("cancelled"));
  assert.match(EDIT_JOBS_SCHEMA, /'cancelled'/);
  assert.match(EDIT_JOBS_SCHEMA, /'completed','failed','cancelled'/);
  assert.ok(!ACTIVE_JOB_STATUSES.includes("cancelled"));
});

test("only active and completed jobs trigger recovery", () => {
  for (const status of ["uploading", "queued", "analyzing", "rendering"]) {
    assert.equal(isActiveJobStatus(status), true);
    assert.equal(isRecoverableJobStatus(status), true);
  }
  assert.equal(isRecoverableJobStatus("completed"), true);
  for (const status of ["failed", "cancelled"]) {
    assert.equal(isActiveJobStatus(status), false);
    assert.equal(isRecoverableJobStatus(status), false);
  }
});

test("normal execution controller leaves its active child unchanged", () => {
  const controller = createExecutionController();
  const child = createMockChild();
  controller.attach(child);
  assert.equal(controller.isCancelled(), false);
  assert.doesNotThrow(() => controller.throwIfCancelled());
  assert.deepEqual(child.signals, []);
  controller.detach(child);
});

test("cancelling an active execution gracefully terminates only its child", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  assert.equal(controller.cancel(), true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.throws(() => controller.throwIfCancelled(), EditExecutionCancelledError);

  child.exitCode = 0;
  controller.detach(child);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a non-exiting cancelled execution receives one bounded force kill", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  controller.cancel();
  controller.cancel();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a cancellation observed before execution starts prevents the next child from running", () => {
  const controller = createExecutionController({ setTimeoutFn: () => null });
  const child = createMockChild();
  controller.cancel();
  controller.attach(child);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(controller.cancel(), false);
});

test("source catalog has stable human-facing IDs at one, two, and five source scale", () => {
  assert.deepEqual(sourceCatalog.map(({ sourceId, ordinal, filename }) => ({ sourceId, ordinal, filename })), [
    { sourceId: "source-1", ordinal: 1, filename: "A.mp4" },
    { sourceId: "source-2", ordinal: 2, filename: "B.mp4" },
    { sourceId: "source-3", ordinal: 3, filename: "C.mp4" }
  ]);
  const one = createSourceCatalog([{ ...video, index: 0, name: "one.mp4" }], [{ duration: 10, width: 1920, height: 1080 }]);
  const two = createSourceCatalog(
    [{ ...video, index: 0, name: "one.mp4" }, { ...video, index: 1, name: "two.mp4" }],
    [{ duration: 10, width: 1920, height: 1080 }, { duration: 10, width: 1920, height: 1080 }]
  );
  assert.deepEqual(one.map((source) => source.sourceId), ["source-1"]);
  assert.deepEqual(two.map((source) => source.sourceId), ["source-1", "source-2"]);
  const five = createSourceCatalog(
    Array.from({ length: 5 }, (_, index) => ({ ...video, index, name: `${index}.mp4` })),
    Array.from({ length: 5 }, () => ({ duration: 10, width: 1920, height: 1080 }))
  );
  assert.equal(five[0].sourceId, "source-1");
  assert.equal(five[4].sourceId, "source-5");
});

test("source-aware fallback preserves requested two-source order", () => {
  const plan = createEditPlan({ prompt: "Put the second video first, then the first.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-aware fallback creates source-local trim clips", () => {
  const plan = createEditPlan({ prompt: "Use the first 5 seconds of video 1, followed by seconds 10-15 of video 2.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips, [
    { sourceId: "source-1", start: 0, end: 5 },
    { sourceId: "source-2", start: 10, end: 15 }
  ]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-specific color grade is scoped before sequence assembly", () => {
  const plan = createEditPlan({ prompt: "Make only video 2 black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[1], { type: "color_grade", sourceId: "source-2", style: "bw" });
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("global multi-video color grades remain a single unscoped operation", () => {
  for (const prompt of ["Make both videos black and white.", "Make all videos black and white."]) {
    const plan = createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog });
    const colorGrades = plan.operations.filter((operation) => operation.type === "color_grade");
    assert.deepEqual(colorGrades, [{ type: "color_grade", style: "bw" }]);
    assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
  }
});

test("Gemini prompt distinguishes global and source-scoped color grades", () => {
  const prompt = buildAiEditorPrompt({ prompt: "Make both videos black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.match(prompt, /exactly one color_grade operation per plan/);
  assert.match(prompt, /both, all, or every video, use one unscoped color_grade without sourceId/);
  assert.match(prompt, /never emit one color_grade per source/);
  assert.match(prompt, /Use sourceId only when the request explicitly limits the grade to one source/);
});

test("source-aware validation allows repeats but rejects bad sources and ranges", () => {
  const repeated = {
    version: "2", operations: [{ type: "sequence", clips: [
      { sourceId: "source-1", start: 0, end: 2 },
      { sourceId: "source-2", start: 0, end: 2 },
      { sourceId: "source-1", start: 2, end: 4 }
    ] }]
  };
  assert.doesNotThrow(() => validateEditPlan(repeated, { sourceCatalog }));
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-4", start: 0, end: 1 }] }] }, { sourceCatalog }), /unknown source/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: -1, end: 1 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 5, end: 5 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 21 }] }] }, { sourceCatalog }), /exceeds/);
});

test("version 2 rejects merge and source IDs on global-only operations", () => {
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "merge" }
  ] }, { sourceCatalog }), /cannot include merge/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "trim", sourceId: "source-1", start: 0, end: 1 }
  ] }, { sourceCatalog }), /sourceId is supported only/);
});

test("source-aware JSON schema limits source IDs to the supplied catalog", () => {
  const schema = createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /source-1/);
  assert.doesNotMatch(serialized, /source-4/);
});

test("semantic multi-source planning pairs each Gemini video with its source ID", async () => {
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [
    { sourceId: "source-2", start: 0, end: 30 }, { sourceId: "source-1", start: 0, end: 20 }
  ] }] }) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Put the homestay video first, then the greenery video.", hasMultipleVideos: true,
    sourceCatalog, sourceInputs: plannerSources(), aiClient, retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(result.source, "gemini");
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.equal(aiClient.uploads.length, 3);
  assert.equal(aiClient.deletes.length, 3);
  const labels = aiClient.requests[0].contents.filter((part) => typeof part === "string" && part.startsWith("SOURCE "));
  assert.match(labels[0], /SOURCE source-1/);
  assert.match(labels[1], /SOURCE source-2/);
  assert.match(labels[2], /SOURCE source-3/);
});

test("semantic source requests reject ambiguity and do not use deterministic fallback", async () => {
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "merge" }] }) });
  await withGeminiKey(async () => {
    await assert.rejects(
      () => createAiEditPlan({ prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient }),
      /identified confidently/
    );
  });
  assert.equal(aiClient.deletes.length, 3);
});

test("transient planning retries reuse uploaded Gemini files", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({
    failures: [error],
    responseText: JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 2 }] }] })
  });
  await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient,
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(aiClient.uploads.length, 3);
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.deletes.length, 3);
  assert.equal(aiClient.requests[0].contents[1].fileData.fileUri, aiClient.requests[1].contents[1].fileData.fileUri);
});

test("retry exhaustion still cleans every uploaded Gemini file", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({ failures: [error, error, error] });
  await withGeminiKey(async () => {
    await assert.rejects(
      () => createAiEditPlan({
        prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient,
        retryOptions: { sleepFn: async () => {}, random: () => 0 }
      }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(aiClient.uploads.length, 3);
  assert.equal(aiClient.requests.length, 3);
  assert.equal(aiClient.deletes.length, 3);
});

test("Gemini-unavailable explicit source requests retain fallback while semantic requests fail safely", async () => {
  const explicit = await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    return createAiEditPlan({ prompt: "Use video 2 then video 1.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() });
  });
  assert.equal(explicit.source, "deterministic");
  await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(
      () => createAiEditPlan({ prompt: "Use the beach clip first.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(requiresVisualSourceUnderstanding("Use video 2 first, then the greenery clip.", sourceCatalog), true);
});

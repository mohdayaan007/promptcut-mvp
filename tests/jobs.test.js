import assert from "node:assert/strict";
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

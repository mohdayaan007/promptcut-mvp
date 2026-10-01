import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DIRECT_UPLOAD_FILE_BYTES, JOB_STATUSES, validateJobRequest, validateUploadManifest } from "@/lib/jobs/job-config";
import { buildNormalizationFilter, createMediaProfile } from "@/lib/editor-core/media-profile";
import { DIRECT_UPLOAD_CORS } from "@/lib/jobs/storage";
import { safeSourceMetadata } from "@/lib/jobs/http";
import { ACTIVE_JOB_STATUSES, isActiveJobStatus, isRecoverableJobStatus } from "@/lib/client/direct-upload";
import { EDIT_JOBS_SCHEMA } from "@/lib/jobs/job-store";

const video = { name: "source.mp4", type: "video/mp4", size: 1024 };

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

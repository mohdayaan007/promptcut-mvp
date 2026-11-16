import assert from "node:assert/strict";
import test from "node:test";
import { referenceRequiresMultipartUpload, validateReferenceColourProfile } from "../src/lib/jobs/job-config.js";

test("numeric browser colour profile remains job metadata, not a multipart reference upload", () => {
  const profile = {
    version: 1, colorSpace: "srgb-rgb24-canvas",
    width: 640, height: 360, sampleCount: 640 * 360 * 5,
    mean: [120, 110, 90], covariance: [[200, 0, 0], [0, 180, 0], [0, 0, 160]]
  };
  const validated = validateReferenceColourProfile(profile);
  assert.equal(validated.kind, "video_profile");
  assert.equal(referenceRequiresMultipartUpload(validated), false);
  assert.equal(referenceRequiresMultipartUpload({ kind: "image", type: "image/jpeg" }), true);
  assert.equal(referenceRequiresMultipartUpload({ kind: "video", type: "video/mp4" }), true);
  assert.equal(referenceRequiresMultipartUpload(null), false);
});

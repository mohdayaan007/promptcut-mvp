import assert from "node:assert/strict";
import test from "node:test";
import { referenceColourProfilesMatch, referenceRequiresMultipartUpload, validateReferenceColourProfile } from "../src/lib/jobs/job-config.js";

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

test("upload completion accepts matching Chrome profile after JSONB canonicalization and optional sample ratios", () => {
  const submitted = {
    version: 1,
    sampleCount: 640 * 360 * 5,
    mean: [120.123, 110.456, 90.789],
    covariance: [[200, 0, 0], [0, 180, 0], [0, 0, 160]],
    sampleRatios: [0.1, 0.3, 0.5, 0.7, 0.9],
    width: 640,
    height: 360,
    colorSpace: "srgb-rgb24-canvas"
  };
  const stored = validateReferenceColourProfile(submitted).profile;
  const reordered = {
    covariance: stored.covariance,
    sampleCount: stored.sampleCount,
    height: stored.height,
    mean: stored.mean,
    version: stored.version,
    width: stored.width,
    colorSpace: stored.colorSpace
  };
  assert.equal(referenceColourProfilesMatch(submitted, reordered), true);
  assert.equal(referenceColourProfilesMatch({ ...submitted, mean: [120.124, 110.456, 90.789] }, stored), false);
  assert.equal(referenceColourProfilesMatch({ ...submitted, sampleCount: 100 }, stored), false);
  assert.equal(referenceColourProfilesMatch(null, stored), false);
  assert.equal(referenceColourProfilesMatch(submitted, null), false);
});

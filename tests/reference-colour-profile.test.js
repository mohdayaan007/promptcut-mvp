import assert from "node:assert/strict";
import test from "node:test";
import { validateReferenceColourProfile } from "../src/lib/jobs/job-config.js";

const profile = Object.freeze({ version: 1, colorSpace: "srgb-rgb24-canvas", width: 640, height: 360, sampleCount: 640 * 360 * 5, mean: [120, 130, 140], covariance: [[30, 2, 1], [2, 25, 3], [1, 3, 20]] });

test("reference colour profile retains aggregate moments only", () => {
  const result = validateReferenceColourProfile(profile);
  assert.deepEqual(result, { kind: "video_profile", profile });
  assert.equal(JSON.stringify(result).includes("pixels"), false);
});

test("reference colour profile rejects non-finite, asymmetric, and non-PSD covariance", () => {
  assert.throws(() => validateReferenceColourProfile({ ...profile, mean: [Infinity, 1, 1] }), /invalid/);
  assert.throws(() => validateReferenceColourProfile({ ...profile, covariance: [[1, 2, 0], [0, 1, 0], [0, 0, 1]] }), /invalid/);
  assert.throws(() => validateReferenceColourProfile({ ...profile, covariance: [[1, 2, 0], [2, 1, 0], [0, 0, 1]] }), /invalid/);
  assert.throws(() => validateReferenceColourProfile({ ...profile, sampleCount: 1 }), /invalid/);
});

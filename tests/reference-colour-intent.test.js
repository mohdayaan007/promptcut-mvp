import assert from "node:assert/strict";
import test from "node:test";
import { requestsReferenceStyleMatch } from "../src/lib/editor-core/reference-style-matching.js";

test("hosted MKL recognizes the founder's exact reference-colour request", () => {
  assert.equal(requestsReferenceStyleMatch("Use the same colour grading as that in the reference video", true), true);
  assert.equal(requestsReferenceStyleMatch("Match the colour grading of my reference video.", true), true);
  assert.equal(requestsReferenceStyleMatch("Apply the same color grade as the reference clip.", true), true);
  assert.equal(requestsReferenceStyleMatch("Use the same colour grading as that in the reference video", false), false);
});

test("reference colour matching stays opt-in and does not recognize unrelated commands", () => {
  assert.equal(requestsReferenceStyleMatch("Trim my video from 00:01 to 00:03", true), false);
  assert.equal(requestsReferenceStyleMatch("Make it cinematic", true), false);
  assert.equal(requestsReferenceStyleMatch("Use the reference video as background music", true), false);
  assert.equal(requestsReferenceStyleMatch("Match this style", true), true);
});

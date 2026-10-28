import test from "node:test";
import assert from "node:assert/strict";
import { recordConversationCompletion, retainedPreviewLabel } from "../src/lib/client/conversation-presentation.js";

test("history hydration and repeated completion polls produce one confirmation per job", () => {
  let messages = [{ role: "user", text: "Also add black and white.", jobId: "job-a" }];
  messages = recordConversationCompletion(messages, "job-a", "Applied black and white.");
  messages = recordConversationCompletion(messages, "job-a", "Applied black and white.");
  assert.equal(messages.length, 2);
  messages = recordConversationCompletion(messages, "job-b", "Applied black and white.");
  assert.equal(messages.length, 3, "distinct jobs retain their own confirmation even for identical prompts");
  assert.equal(messages[1].jobId, "job-a");
});

test("a retained preview is explicitly previous during every active phase and after failure", () => {
  for (const status of ["uploading", "queued", "analyzing", "rendering", "error"]) {
    assert.equal(retainedPreviewLabel(status, 15.028), "Previous edit (15s)");
    assert.equal(retainedPreviewLabel(status, NaN), "Previous edit");
  }
  assert.equal(retainedPreviewLabel("done", 10), null);
});

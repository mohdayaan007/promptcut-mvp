import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticTestGemini } from "../src/lib/editor-core/ai-editor/synthetic-test-gemini.js";

test("synthetic Gemini derives a finite source-local sequence from planner evidence", async () => {
  const client = createSyntheticTestGemini();
  const source = { sourceId: "source-1", duration: 3, index: 0 };
  const response = await client.models.generateContent({
    contents: [{ fileData: { fileUri: "gemini://synthetic/1" } }, `Authoritative source catalog: ${JSON.stringify([source])}`]
  });
  assert.deepEqual(JSON.parse(response.text), {
    version: "2",
    operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 3 }] }]
  });
});

test("synthetic Gemini rejects missing or invalid authoritative duration rather than producing invalid evidence", async () => {
  const client = createSyntheticTestGemini();
  await assert.rejects(
    client.models.generateContent({ contents: ["Authoritative source catalog: []"] }),
    /finite authoritative source duration/
  );
});

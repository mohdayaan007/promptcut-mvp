import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyConversationTurn, validateConversationPlan } from "@/lib/editor-core/conversation-state";
import { executeEditPlan } from "@/lib/editor-core/edit-executor";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { probeVideoFile } from "@/lib/media/media-probe";

const execFileAsync = promisify(execFile);

test("five-turn cumulative conversation renders a valid MP4 from the original source", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-conversation-e2e-"));
  const input = path.join(directory, "original.mp4");
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "8", "-pix_fmt", "yuv420p", input]);
    const media = await probeVideoFile(input);
    const catalog = createSourceCatalog([{ index: 0, name: "original.mp4", type: "video/mp4", size: (await stat(input)).size }], [media]);
    // The first turn is the existing spoken/Gemini pathway's resolved Ahmed range.
    let plan = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 7 }] }] };
    for (const prompt of [
      "Now trim the first five seconds too.",
      "Also add black and white.",
      "Replace that with the cinematic style.",
      "Bring it back to normal."
    ]) plan = applyConversationTurn({ priorPlan: plan, prompt, sourceCatalog: catalog }).plan;
    const validated = validateConversationPlan(plan, catalog);
    assert.deepEqual(validated.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 6, end: 7 }] }]);
    const output = await executeEditPlan({ inputPaths: [input], media: [media], plan: validated, sourceCatalog: catalog, tempDirectory: directory });
    const outputMedia = await probeVideoFile(output);
    assert.ok(output.endsWith(".mp4"));
    assert.ok(outputMedia.duration > 0.8 && outputMedia.duration < 1.2, `expected one-second output, got ${outputMedia.duration}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

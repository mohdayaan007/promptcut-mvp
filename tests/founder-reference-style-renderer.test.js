import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { hyperframesBinary, renderFounderReferenceStyleComposition } from "../src/lib/editor-core/founder-reference-style-renderer.js";
import { createReferenceStyleV1Composition } from "../src/lib/editor-core/reference-style-v1-composition.js";
import { createRve1QualityProfile } from "../src/lib/editor-core/reference-style-v1.js";

test("portable HyperFrames binary resolves within the application by default", () => {
  const saved = process.env.HYPERFRAMES_BIN; delete process.env.HYPERFRAMES_BIN;
  try { assert.equal(hyperframesBinary(), path.join(process.cwd(), "node_modules", ".bin", "hyperframes")); }
  finally { if (saved === undefined) delete process.env.HYPERFRAMES_BIN; else process.env.HYPERFRAMES_BIN = saved; }
});

test("renderer rejects non-server trusted paths before spawning a browser", async () => {
  const composition = createReferenceStyleV1Composition({ profile: createRve1QualityProfile(), title: "Safe title" });
  await assert.rejects(() => renderFounderReferenceStyleComposition({ composition, sourcePath: "relative.mp4", outputPath: "/tmp/out.mp4", duration: 15.55, width: 1920, height: 1080, temporaryDirectory: "/tmp/renderer", rendererPath: "/app/node_modules/.bin/hyperframes" }), /trusted paths/);
  await assert.rejects(() => renderFounderReferenceStyleComposition({ composition, sourcePath: "/tmp/source.mp4", outputPath: "/tmp/out.mp4", duration: 15.55, width: 0, height: 1080, temporaryDirectory: "/tmp/renderer", rendererPath: "/app/node_modules/.bin/hyperframes" }), /dimensions/);
});

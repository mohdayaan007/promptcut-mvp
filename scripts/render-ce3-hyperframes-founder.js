import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { createCe3HyperframesComposition, applyCe3HyperframesRevision } from "@/lib/editor-core/ce3-hyperframes-composition";
import { renderHyperframesLocally } from "@/lib/editor-core/hyperframes-local-renderer";

const sourcePath = process.env.CE_CREATIVE_SOURCE_PATH || "/Users/ayaan/cliponaut-ce0-media/sources/RVE1/Cliponaut Team Video - Mohammed Ayaan.mp4";
const rendererPath = process.env.HYPERFRAMES_LOCAL_BIN || "/Users/ayaan/cliponaut-hyperframes-eval/node_modules/.bin/hyperframes";
const outputDirectory = process.env.CE_CREATIVE_OUTPUT_DIRECTORY || "/Users/ayaan/cliponaut-creative-engine-review/hyperframes";
const requests = process.argv.slice(2);
const run = async () => {
  await stat(sourcePath); await stat(rendererPath); await mkdir(outputDirectory, { recursive: true });
  const catalog = createSourceCatalog([{ index: 0, name: path.basename(sourcePath) }], [{ duration: 117.098089, width: 1280, height: 720, hasAudio: true }]);
  let composition = createCe3HyperframesComposition();
  for (const request of requests) composition = applyCe3HyperframesRevision(composition, request, catalog);
  const outputPath = path.join(outputDirectory, `founder-ce3-r${composition.revision}.mp4`);
  const result = await renderHyperframesLocally({ composition, sourceCatalog: catalog, sourcePath, outputPath, rendererPath, temporaryDirectory: path.join(outputDirectory, `scratch-r${composition.revision}`) });
  console.log(JSON.stringify({ ...result, revision: composition.revision, history: composition.revisionHistory }, null, 2));
};
run().catch((error) => { console.error(error instanceof Error ? error.message : "CE-3 render failed"); process.exitCode = 1; });

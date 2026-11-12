import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { createExecutionController, executeEditPlan } from "@/lib/editor-core/edit-executor";
import { CE1_PRODUCT_GRAPHIC, createCe1FounderReelPlan, createCe1KineticAssDocument, validateCe1FounderReelPlan } from "@/lib/editor-core/ce1-founder-reel";
import { createCe2Composition, createCe2RevisionExample } from "@/lib/editor-core/ce2-composition-revisions";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { buildAssFilter } from "@/lib/title-renderer";

const run = promisify(execFile);
const sourcePath = "/Users/ayaan/cliponaut-ce0-media/sources/RVE1/Cliponaut Team Video - Mohammed Ayaan.mp4";
const outputDirectory = "/Users/ayaan/cliponaut-creative-engine-review";
// The standard Homebrew build on this machine intentionally omits libass.
// CE-1 uses the already-installed full build only for the private kinetic
// composition pass; normal Cliponaut worker execution is unchanged.
const assCompositor = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const scratch = path.join(outputDirectory, "scratch");
const exampleName = process.argv[2] === "--ce2-revision" ? process.argv[3] : null;
const fileStem = exampleName ? `founder-rve1-hybrid-ce2-${exampleName}` : "founder-rve1-hybrid-ce1-v3-recovered";
const outputPath = path.join(outputDirectory, `${fileStem}.mp4`);
const assPath = path.join(scratch, "ce1-kinetic-layers.ass");
const logoPath = path.join(scratch, "cliponaut-wordmark.png");
const reviewPath = path.join(outputDirectory, `${fileStem}-review.jpg`);
const comparisonPath = exampleName ? path.join(outputDirectory, `${fileStem}-comparison.jpg`) : null;
const manifestPath = path.join(outputDirectory, `${fileStem}-manifest.json`);

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", file]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  return { duration: Number(parsed.format.duration), width: video?.width, height: video?.height, hasAudio: Boolean(audio), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, frameRate: video?.r_frame_rate };
}

async function main() {
  await stat(sourcePath);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const media = await probe(sourcePath);
  if (!media.hasAudio || media.videoCodec !== "h264" || media.width !== 1280 || media.height !== 720) throw new Error("CE-1 requires the verified RVE1 founder source media profile");
  const sourceCatalog = createSourceCatalog([{ index: 0, name: path.basename(sourcePath) }], [media]);
  const composition = exampleName ? createCe2RevisionExample(exampleName, sourceCatalog) : null;
  const validated = validateCe1FounderReelPlan(composition?.plan || createCe1FounderReelPlan(), sourceCatalog);
  const executionController = createExecutionController();
  const baseOutput = await executeEditPlan({
    inputPaths: [sourcePath], media: [media], plan: validated.plan, sourceCatalog,
    tempDirectory: scratch, exportQuality: "standard", executionController
  });
  await writeFile(assPath, createCe1KineticAssDocument(composition?.textLayers), "utf8");
  const logoSource = path.resolve(process.cwd(), CE1_PRODUCT_GRAPHIC.relativePath);
  const logoDigest = createHash("sha256").update(await readFile(logoSource)).digest("hex");
  if (logoDigest !== CE1_PRODUCT_GRAPHIC.sha256) throw new Error("CE-1 product graphic identity verification failed");
  await run("sips", ["-s", "format", "png", logoSource, "--out", logoPath]);
  // Finish as 30fps CFR for broadly compatible playback; sequence assembly
  // preserves source timestamps before this final deterministic export pass.
  const logoFilter = `[1:v]format=rgba,fade=t=in:st=${CE1_PRODUCT_GRAPHIC.start}:d=0.28:alpha=1,fade=t=out:st=7.16:d=0.24:alpha=1[logo];[0:v]fps=30,${buildAssFilter(assPath)}[typed];[typed][logo]overlay=x='if(lt(t,3.1),1180-(t-${CE1_PRODUCT_GRAPHIC.start})*850,840)':y=548:eval=frame:enable='between(t,${CE1_PRODUCT_GRAPHIC.start},${CE1_PRODUCT_GRAPHIC.end})'[v]`;
  await run(assCompositor, ["-y", "-hide_banner", "-loglevel", "error", "-i", baseOutput, "-i", logoPath, "-filter_complex", logoFilter, "-map", "[v]", "-map", "0:a:0", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", outputPath]);
  // Five composited review moments demonstrate title entrances, hierarchy,
  // the animated accent, and the closing beat without retaining source media.
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.7", "-i", outputPath, "-vf", "fps=1/2.4,scale=426:-1,tile=5x1:padding=8:color=0x171A20", "-frames:v", "1", reviewPath]);
  if (comparisonPath) {
    const baselinePath = path.join(outputDirectory, "founder-rve1-hybrid-ce1-v3-recovered.mp4");
    let beforePath = baselinePath;
    if (exampleName === "text-correction") {
      const fixtureAssPath = path.join(scratch, "ce2-title-correction-before.ass");
      const fixturePath = path.join(scratch, "ce2-title-correction-before.mp4");
      await writeFile(fixtureAssPath, createCe1KineticAssDocument(createCe2Composition({ seededOldName: true }).textLayers), "utf8");
      const fixtureFilter = `[1:v]format=rgba,fade=t=in:st=${CE1_PRODUCT_GRAPHIC.start}:d=0.28:alpha=1,fade=t=out:st=7.16:d=0.24:alpha=1[logo];[0:v]fps=30,${buildAssFilter(fixtureAssPath)}[typed];[typed][logo]overlay=x='if(lt(t,3.1),1180-(t-${CE1_PRODUCT_GRAPHIC.start})*850,840)':y=548:eval=frame:enable='between(t,${CE1_PRODUCT_GRAPHIC.start},${CE1_PRODUCT_GRAPHIC.end})'[v]`;
      await run(assCompositor, ["-y", "-hide_banner", "-loglevel", "error", "-i", baseOutput, "-i", logoPath, "-filter_complex", fixtureFilter, "-map", "[v]", "-map", "0:a:0", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", fixturePath]);
      beforePath = fixturePath;
    } else await stat(baselinePath);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", beforePath, "-i", outputPath, "-filter_complex", "[0:v]fps=1/4,scale=426:-1,tile=3x1:padding=8:color=0x171A20[a];[1:v]fps=1/4,scale=426:-1,tile=3x1:padding=8:color=0x171A20[b];[a][b]vstack=inputs=2", "-frames:v", "1", comparisonPath]);
  }
  const output = await probe(outputPath);
  if (Math.abs(output.duration - validated.duration) > 0.15 || output.videoCodec !== "h264" || output.audioCodec !== "aac") throw new Error("CE-1 output verification failed");
  await writeFile(manifestPath, `${JSON.stringify({
    version: composition ? "ce2-composition/1" : "ce1-founder-reel/2-recovered", renderer: "ffmpeg-libass-hybrid", recovery: { status: "reconstructed-from-documented-v3-specification", originalV3ArtifactAvailable: false }, hyperframes: { status: "hold", reason: "published dependency could not resolve in isolated npm install" },
    source: { sourceId: "source-1", duration: media.duration, frameRate: media.frameRate },
    output: { path: outputPath, duration: output.duration, width: output.width, height: output.height, videoCodec: output.videoCodec, audioCodec: output.audioCodec },
    selections: validated.plan.operations[0].clips,
    transcriptEvidence: validated.transcriptEvidence,
    visualAdjustment: validated.plan.operations[1],
    productGraphic: CE1_PRODUCT_GRAPHIC,
    composition: composition ? { compositionId: composition.compositionId, revision: composition.revision, parentRevision: composition.parentRevision, revisionHistory: composition.revisionHistory, textLayers: composition.textLayers } : null
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "completed", outputPath, reviewPath, comparisonPath, manifestPath, duration: output.duration }, null, 2));
}

main().catch((error) => {
  console.error("CE-1 render failed:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});

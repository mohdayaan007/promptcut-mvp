import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createExecutionController, executeEditPlan } from "@/lib/editor-core/edit-executor";
import { createCe1FounderReelPlan, createCe1KineticAssDocument, validateCe1FounderReelPlan } from "@/lib/editor-core/ce1-founder-reel";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { buildAssFilter } from "@/lib/title-renderer";

const run = promisify(execFile);
const sourcePath = "/Users/ayaan/cliponaut-ce0-media/sources/RVE1/Cliponaut Team Video - Mohammed Ayaan.mp4";
const outputDirectory = "/private/tmp/cliponaut-ce1-founder-reel";
// The standard Homebrew build on this machine intentionally omits libass.
// CE-1 uses the already-installed full build only for the private kinetic
// composition pass; normal Cliponaut worker execution is unchanged.
const assCompositor = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const scratch = path.join(outputDirectory, "scratch");
const outputPath = path.join(outputDirectory, "founder-rve1-hybrid-ce1.mp4");
const assPath = path.join(scratch, "ce1-kinetic-layers.ass");
const reviewPath = path.join(outputDirectory, "founder-rve1-hybrid-ce1-review.jpg");
const manifestPath = path.join(outputDirectory, "founder-rve1-hybrid-ce1-manifest.json");

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", file]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  return { duration: Number(parsed.format.duration), width: video?.width, height: video?.height, hasAudio: Boolean(audio), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, frameRate: video?.r_frame_rate };
}

async function main() {
  await stat(sourcePath);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const media = await probe(sourcePath);
  if (!media.hasAudio || media.videoCodec !== "h264" || media.width !== 1280 || media.height !== 720) throw new Error("CE-1 requires the verified RVE1 founder source media profile");
  const sourceCatalog = createSourceCatalog([{ index: 0, name: path.basename(sourcePath) }], [media]);
  const validated = validateCe1FounderReelPlan(createCe1FounderReelPlan(), sourceCatalog);
  const executionController = createExecutionController();
  const baseOutput = await executeEditPlan({
    inputPaths: [sourcePath], media: [media], plan: validated.plan, sourceCatalog,
    tempDirectory: scratch, exportQuality: "standard", executionController
  });
  await writeFile(assPath, createCe1KineticAssDocument(), "utf8");
  // Finish as 30fps CFR for broadly compatible playback; sequence assembly
  // preserves source timestamps before this final deterministic export pass.
  await run(assCompositor, ["-y", "-hide_banner", "-loglevel", "error", "-i", baseOutput, "-vf", `fps=30,${buildAssFilter(assPath)}`, "-map", "0:v:0", "-map", "0:a:0", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outputPath]);
  // Five composited review moments demonstrate title entrances, hierarchy,
  // the animated accent, and the closing beat without retaining source media.
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.7", "-i", outputPath, "-vf", "fps=1/2.4,scale=426:-1,tile=5x1:padding=8:color=0x171A20", "-frames:v", "1", reviewPath]);
  const output = await probe(outputPath);
  if (Math.abs(output.duration - validated.duration) > 0.15 || output.videoCodec !== "h264" || output.audioCodec !== "aac") throw new Error("CE-1 output verification failed");
  await writeFile(manifestPath, `${JSON.stringify({
    version: "ce1-founder-reel/1", renderer: "ffmpeg-libass-hybrid", hyperframes: { status: "hold", reason: "published dependency could not resolve in isolated npm install" },
    source: { sourceId: "source-1", duration: media.duration, frameRate: media.frameRate },
    output: { path: outputPath, duration: output.duration, width: output.width, height: output.height, videoCodec: output.videoCodec, audioCodec: output.audioCodec },
    selections: validated.plan.operations[0].clips,
    transcriptEvidence: validated.transcriptEvidence,
    visualAdjustment: validated.plan.operations[1]
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "completed", outputPath, reviewPath, manifestPath, duration: output.duration }, null, 2));
}

main().catch((error) => {
  console.error("CE-1 render failed:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyConversationTurn, validateConversationPlan } from "../src/lib/editor-core/conversation-state.js";
import { createEditPlan } from "../src/lib/editor-core/edit-plan.js";
import { executeEditPlan } from "../src/lib/editor-core/edit-executor.js";
import { createSourceCatalog } from "../src/lib/editor-core/source-catalog.js";
import { probeVideoFile } from "../src/lib/media/media-probe.js";

const run = promisify(execFile);
async function frame(file, time) {
  return (await run("ffmpeg", ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=160:90", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" })).stdout;
}
function mse(a, b) {
  assert.equal(a.length, b.length);
  return a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0) / a.length;
}
async function audio(file, start, duration) {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(start), "-i", file, "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 8e6 });
  return Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
}
function alignment(reference, candidate) {
  let best = { correlation: -1, lagSamples: 0 };
  for (let lag = -480; lag <= 480; lag++) {
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 512; i < Math.min(reference.length, candidate.length) - 512; i += 4) {
      const a = reference[i]; const b = candidate[i + lag];
      dot += a * b; aa += a * a; bb += b * b;
    }
    const correlation = dot / Math.sqrt(aa * bb);
    if (correlation > best.correlation) best = { correlation, lagSamples: lag };
  }
  return best;
}

test("eight independently rendered turns preserve start cuts, replace styles, and keep audio aligned", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-eight-turns-"));
  const evidence = process.env.PHASE4_EVIDENCE_DIRECTORY;
  try {
    const input = path.join(root, "original.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*(200*t+12*t*t)):s=48000", "-t", "34", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input]);
    const media = await probeVideoFile(input);
    const catalog = createSourceCatalog([{ index: 0, name: "original.mp4", type: "video/mp4", size: (await stat(input)).size }], [media]);
    // Explicit fixture selection, NOT a speech/Gemini acceptance claim.
    let plan = { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 10, end: 25 }] }] };
    const prompts = [null, "Now trim the first five seconds too.", "Also add black and white.", "Make it cinematic instead.", "Bring it back to normal.", "Also add black and white.", "Make it cinematic instead.", "Bring it back to normal."];
    const outputs = []; const results = [];
    for (const [i, prompt] of prompts.entries()) {
      if (prompt) plan = applyConversationTurn({ priorPlan: plan, prompt, sourceCatalog: catalog }).plan;
      const scratch = path.join(root, `turn-${i + 1}`);
      await mkdir(scratch);
      const output = await executeEditPlan({ inputPaths: [input], media: [media], plan: validateConversationPlan(plan, catalog), sourceCatalog: catalog, tempDirectory: scratch });
      outputs.push(output);
      const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,start_time,duration,nb_read_frames", "-of", "json", output])).stdout);
      const video = probe.streams.find(s => s.codec_type === "video");
      const sound = probe.streams.find(s => s.codec_type === "audio");
      const expected = i === 0 ? 15 : 10;
      assert.ok(Math.abs(Number(probe.format.duration) - expected) < 0.12);
      assert.ok(Math.abs(Number(video.duration) - Number(sound.duration)) < 0.12);
      assert.ok(Number(video.nb_read_frames) >= expected * 30 - 2);
      await run("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
      results.push({ turn: i + 1, prompt: prompt || "explicit fixture selection 10–25s", plan: structuredClone(plan), probe });
      if (evidence) { await mkdir(evidence, { recursive: true }); await copyFile(output, path.join(evidence, `turn-${i + 1}.mp4`)); }
    }
    const trimFrame = await frame(outputs[1], 0.5);
    const matches = {
      expectedPreviousPlusFive: mse(trimFrame, await frame(outputs[0], 5.5)),
      wrongEndTrim: mse(trimFrame, await frame(outputs[0], 0.5)),
      wrongOriginalPlusFive: mse(trimFrame, await frame(input, 5.5)),
      retainedEnding: mse(await frame(outputs[1], 9.8), await frame(outputs[0], 14.8)),
      normalReset: mse(trimFrame, await frame(outputs[4], 0.5)),
      cinematic: mse(trimFrame, await frame(outputs[3], 0.5))
    };
    assert.ok(matches.expectedPreviousPlusFive < matches.wrongEndTrim / 5, JSON.stringify(matches));
    assert.ok(matches.expectedPreviousPlusFive < matches.wrongOriginalPlusFive / 5, JSON.stringify(matches));
    assert.ok(matches.retainedEnding < 25, JSON.stringify(matches));
    assert.ok(matches.normalReset < 1, JSON.stringify(matches));
    assert.ok(matches.cinematic > 5, JSON.stringify(matches));
    const bw = await frame(outputs[2], 0.5);
    let chroma = 0;
    for (let i = 0; i < bw.length; i += 3) chroma += Math.abs(bw[i] - bw[i + 1]) + Math.abs(bw[i + 1] - bw[i + 2]);
    assert.ok(chroma / (bw.length / 3) < 2, "BW output must be monochrome");
    const audioAlignment = alignment(await audio(outputs[0], 6, 2), await audio(outputs[1], 1, 2));
    assert.ok(audioAlignment.correlation > 0.95, JSON.stringify(audioAlignment));
    assert.ok(Math.abs(audioAlignment.lagSamples) / 16000 < 0.025, JSON.stringify(audioAlignment));
    if (evidence) await writeFile(path.join(evidence, "media-results.json"), JSON.stringify({ fixture: "synthetic explicit 10–25s selection; no semantic model", results, frameMSE: matches, audioAlignment }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timestamp trim removes the requested middle interval and joins synchronized retained footage", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-remove-interval-"));
  try {
    const input = path.join(root, "source.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*(200*t+12*t*t)):s=48000", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input]);
    const media = await probeVideoFile(input);
    const catalog = createSourceCatalog([{ index: 0, name: "source.mp4", type: "video/mp4", size: (await stat(input)).size }], [media]);
    const plan = applyConversationTurn({ priorPlan: { version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] }, prompt: "Trim from 0:08 to 0:12", sourceCatalog: catalog }).plan;
    const scratch = path.join(root, "render"); await mkdir(scratch);
    const output = await executeEditPlan({ inputPaths: [input], media: [media], plan: validateConversationPlan(plan, catalog), sourceCatalog: catalog, tempDirectory: scratch });
    const rendered = await probeVideoFile(output);
    assert.ok(Math.abs(rendered.duration - 16) < 0.15, `duration ${rendered.duration}`);
    assert.ok(mse(await frame(output, 7.5), await frame(input, 7.5)) < 25);
    assert.ok(mse(await frame(output, 8.5), await frame(input, 12.5)) < 25);
    const sync = alignment(await audio(input, 12.5, 1), await audio(output, 8.5, 1));
    assert.ok(sync.correlation > 0.95, JSON.stringify(sync));
    // Initial requests use the same public wording contract. Render every
    // variant so duration and retained footage cannot regress in parser-only
    // tests while the follow-up path remains covered above.
    for (const [index, prompt, expectedDuration, outputAt, expectedAt] of [
      [1, "Keep only 0:08 to 0:12", 4, 0.5, 8.5],
      [2, "Remove 0:08 to 0:12", 16, 8.5, 12.5],
      [3, "Cut out 0:08 to 0:12", 16, 8.5, 12.5],
      [4, "Trim from 0:08 to 0:12", 16, 8.5, 12.5]
    ]) {
      const renderDirectory = path.join(root, `initial-${index}`); await mkdir(renderDirectory);
      const outputPath = await executeEditPlan({ inputPaths: [input], media: [media], plan: validateConversationPlan(createEditPlan({ prompt, sourceCatalog: catalog }), catalog), sourceCatalog: catalog, tempDirectory: renderDirectory });
      const probe = await probeVideoFile(outputPath);
      assert.ok(Math.abs(probe.duration - expectedDuration) < 0.15, `${prompt}: ${probe.duration}`);
      assert.ok(mse(await frame(outputPath, outputAt), await frame(input, expectedAt)) < 25, prompt);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

// Separate, bounded production check. A founder enters the access code only in
// the visible browser; it is never read, persisted, or placed in the report.
const run = promisify(execFile);
const target = "https://cliponaut.com";
const enabled = process.env.PHASE4_HOSTED_NORMAL_VERIFY === "1";
const fixture = path.resolve(process.env.PHASE4_HOSTED_NORMAL_VIDEO || "public/demo.mp4");
const reportPath = path.resolve(process.env.PHASE4_HOSTED_NORMAL_REPORT_PATH || path.join(os.tmpdir(), "cliponaut-phase4-normal-report.json"));

function safeError(error) { return error?.name === "AssertionError" ? "assertion failed" : (error?.name || "unknown error"); }
function result(report, name, status, detail = undefined) { report.checks.push({ name, status, ...(detail ? { detail } : {}) }); }
function hostname(value) { try { return new URL(value).hostname || null; } catch { return null; } }

async function ffprobe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name", "-of", "json", file]);
  const value = JSON.parse(stdout); const duration = Number(value.format?.duration);
  assert.match(value.format?.format_name || "", /mp4/);
  assert.ok(value.streams?.some((stream) => stream.codec_type === "video"));
  assert.ok(value.streams?.some((stream) => stream.codec_type === "audio"));
  assert.ok(Number.isFinite(duration) && duration > 5);
  return { duration, videoCodec: value.streams.find((stream) => stream.codec_type === "video")?.codec_name || null, audioCodec: value.streams.find((stream) => stream.codec_type === "audio")?.codec_name || null };
}
async function rawFfmpeg(args) { const { stdout } = await run("ffmpeg", args, { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }); return Buffer.from(stdout); }
async function videoSample(file, second) { return rawFfmpeg(["-v", "error", "-ss", String(second), "-i", file, "-frames:v", "1", "-vf", "scale=160:90:flags=bilinear", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]); }
async function audioSample(file, second) { return rawFfmpeg(["-v", "error", "-ss", String(second), "-t", "0.5", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]); }

function distance(left, right, audio = false) {
  const size = audio ? Math.min(left.length, right.length) - (Math.min(left.length, right.length) % 2) : Math.min(left.length, right.length);
  assert.ok(size >= (audio ? 4_000 : 160 * 90 * 3));
  let total = 0;
  if (audio) for (let i = 0; i < size; i += 2) total += Math.abs(left.readInt16LE(i) - right.readInt16LE(i));
  else for (let i = 0; i < size; i += 1) total += Math.abs(left[i] - right[i]);
  return total / (audio ? (size / 2) * 65_535 : size * 255);
}

async function download(page, root, label, report) {
  const href = await page.getByRole("link", { name: "Download MP4" }).getAttribute("href");
  assert.ok(href?.startsWith("https://"));
  const response = await page.request.get(href);
  report.downloads.push({ label, hostname: hostname(href), status: response.status(), mimeType: response.headers()["content-type"]?.split(";")[0] || null });
  assert.equal(response.status(), 200);
  const file = path.join(root, `${label}.mp4`);
  await writeFile(file, await response.body());
  return { file, ...(await ffprobe(file)) };
}
async function submit(page, prompt) { await page.getByLabel("Describe your video edit").fill(prompt); await page.getByRole("button", { name: "Generate" }).click(); }
async function waitForOutput(page, oldHref = null, timeout = 180_000) {
  const terminal = await page.waitForFunction((previous) => {
    const error = document.querySelector(".cliponaut-preview-retained-error");
    if (error?.textContent?.trim()) return "error";
    const link = document.querySelector("a.cliponaut-download-button");
    return link?.href && (!previous || link.href !== previous) ? "completed" : false;
  }, oldHref, { timeout });
  assert.equal(await terminal.jsonValue(), "completed", "hosted job completed without a retained-preview error");
  await page.getByText("Ready", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
}
async function followUp(page, prompt) {
  const oldHref = await page.getByRole("link", { name: "Download MP4" }).getAttribute("href");
  const responsePromise = page.waitForResponse((response) => {
    try { return response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/api/editing-sessions/"); } catch { return false; }
  }, { timeout: 30_000 });
  await submit(page, prompt);
  const response = await responsePromise;
  assert.equal(response.status(), 200, "follow-up was accepted by the editing-session API");
  await waitForOutput(page, oldHref);
}

test("hosted Chrome check: cinematic to normal restores color and keeps the five-second trim", { timeout: 10 * 60_000, skip: !enabled }, async () => {
  const report = { suite: "hosted-phase4-normal", target, generatedAt: new Date().toISOString(), checks: [], downloads: [] };
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-phase4-normal-"));
  let browser; let context;
  try {
    const original = await ffprobe(fixture);
    result(report, "Small local fixture", "PASS", { durationSeconds: Number(original.duration.toFixed(3)) });
    browser = await chromium.launch({ channel: "chrome", headless: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${target}/founder-test`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByLabel("Access code").waitFor({ state: "visible", timeout: 30_000 });
    console.log("Founder login required in visible Google Chrome. Enter the access code once; this short check continues automatically.");
    await page.waitForURL((url) => url.origin === target && url.pathname === "/", { timeout: 5 * 60_000 });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Video" }).click();
    await (await chooser).setFiles(fixture);
    await page.getByRole("heading", { name: "Your target media" }).waitFor({ state: "visible", timeout: 30_000 });

    await submit(page, "Also add black and white.");
    await waitForOutput(page);
    const blackAndWhite = await download(page, root, "black-and-white", report);
    await followUp(page, "Now trim the first five seconds too.");
    const trimmed = await download(page, root, "trimmed", report);
    await followUp(page, "Replace that with the cinematic style.");
    const cinematic = await download(page, root, "cinematic", report);
    await followUp(page, "Bring it back to normal.");
    await page.getByText("Restored the original color treatment while keeping your earlier edits.").waitFor({ state: "visible", timeout: 30_000 });
    const normal = await download(page, root, "normal", report);

    assert.ok(Math.abs(trimmed.duration - (blackAndWhite.duration - 5)) < 1, "follow-up trim is output-relative");
    assert.ok(Math.abs(cinematic.duration - trimmed.duration) < 0.75, "cinematic keeps trim");
    assert.ok(Math.abs(normal.duration - trimmed.duration) < 0.75, "normal keeps trim");
    const [openingVideo, endingVideo, openingAudio, endingAudio, cinematicDelta] = await Promise.all([
      Promise.all([videoSample(fixture, 5.5), videoSample(normal.file, 0.5)]).then(([a, b]) => distance(a, b)),
      Promise.all([videoSample(fixture, Math.max(0.5, original.duration - 0.75)), videoSample(normal.file, Math.max(0.5, normal.duration - 0.75))]).then(([a, b]) => distance(a, b)),
      Promise.all([audioSample(fixture, 5.5), audioSample(normal.file, 0.5)]).then(([a, b]) => distance(a, b, true)),
      Promise.all([audioSample(fixture, Math.max(0.5, original.duration - 0.75)), audioSample(normal.file, Math.max(0.5, normal.duration - 0.75))]).then(([a, b]) => distance(a, b, true)),
      Promise.all([videoSample(cinematic.file, 0.5), videoSample(normal.file, 0.5)]).then(([a, b]) => distance(a, b))
    ]);
    assert.ok(openingVideo < 0.15 && endingVideo < 0.15, "normal video is the original trimmed window");
    assert.ok(openingAudio < 0.12 && endingAudio < 0.12, "normal audio is aligned to the original trimmed window");
    assert.ok(cinematicDelta > 0.003, "normal output differs from the cinematic treatment");
    result(report, "Cinematic to normal restoration", "PASS", { durationSeconds: Number(normal.duration.toFixed(3)), openingVideoDistance: Number(openingVideo.toFixed(4)), endingVideoDistance: Number(endingVideo.toFixed(4)), openingAudioDistance: Number(openingAudio.toFixed(4)), endingAudioDistance: Number(endingAudio.toFixed(4)), cinematicVideoDistance: Number(cinematicDelta.toFixed(4)) });
  } catch (error) {
    result(report, "Short hosted normal verification", "FAIL", safeError(error));
    throw error;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Sanitized hosted normal report written to ${reportPath}`);
    await context?.close(); await browser?.close(); await rm(root, { recursive: true, force: true });
  }
});

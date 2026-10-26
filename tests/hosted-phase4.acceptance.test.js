import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const PRODUCTION_URL = "https://cliponaut.com";
const sourceVideo = process.env.PHASE4_HOSTED_VIDEO;
const reportPath = path.resolve(process.env.PHASE4_HOSTED_REPORT_PATH || path.join(os.tmpdir(), "cliponaut-phase4-hosted-report.json"));

function safeFailure(error) {
  // Never put a signed URL, cookie, access code, session token, or media path in
  // the report. The error type is sufficient to diagnose a failed check.
  return error?.name === "AssertionError" ? "assertion failed" : (error?.name || "unknown error");
}

function result(report, name, status, detail = undefined) {
  report.checks.push({ name, status, ...(detail ? { detail } : {}) });
}

async function probeMp4(file) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name",
    "-of", "json", file
  ]);
  const probe = JSON.parse(stdout);
  const duration = Number(probe.format?.duration);
  assert.match(probe.format?.format_name || "", /mp4/);
  assert.ok(probe.streams?.some((stream) => stream.codec_type === "video"), "MP4 has a video stream");
  assert.ok(probe.streams?.some((stream) => stream.codec_type === "audio"), "MP4 has an audio stream");
  assert.ok(Number.isFinite(duration) && duration > 0, "MP4 has a finite duration");
  return { duration, videoCodec: probe.streams.find((stream) => stream.codec_type === "video")?.codec_name || null, audioCodec: probe.streams.find((stream) => stream.codec_type === "audio")?.codec_name || null };
}

async function firstFrameHash(file) {
  const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "framemd5", "-"]);
  return stdout.trim().split("\n").filter((line) => line && !line.startsWith("#")).at(-1) || "";
}

async function waitForReady(page, timeout = 180_000) {
  await page.getByText("Ready", { exact: true }).waitFor({ state: "visible", timeout });
  const video = page.locator("video.cliponaut-result-video");
  await video.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const element = document.querySelector("video.cliponaut-result-video");
    return element && element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 0;
  }, { timeout: 30_000 });
  return Number(await video.evaluate((element) => element.duration));
}

async function submitTurn(page, prompt) {
  await page.getByLabel("Describe your video edit").fill(prompt);
  await page.getByRole("button", { name: "Generate" }).click();
}

async function downloadAndProbe(page, directory, label) {
  const href = await page.getByRole("link", { name: "Download MP4" }).getAttribute("href");
  assert.ok(href && href.startsWith("https://"), "download uses an HTTPS signed URL");
  const response = await page.request.get(href);
  assert.equal(response.status(), 200, "download succeeds");
  const target = path.join(directory, `${label}.mp4`);
  await writeFile(target, await response.body());
  return { ...(await probeMp4(target)), firstFrame: await firstFrameHash(target) };
}

test("hosted Phase 4 founder acceptance against cliponaut.com", { timeout: 12 * 60_000 }, async () => {
  assert.ok(sourceVideo, "PHASE4_HOSTED_VIDEO must point to Ahmed Perfumes Testing.mp4");
  await access(sourceVideo);
  await mkdir(path.dirname(reportPath), { recursive: true });

  const report = { suite: "hosted-phase4", target: PRODUCTION_URL, generatedAt: new Date().toISOString(), checks: [] };
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cliponaut-hosted-phase4-"));
  let browser;
  let desktop;
  try {
    const source = await probeMp4(sourceVideo);
    assert.ok(Math.abs(source.duration - 34.738) < 1, "Ahmed fixture duration is approximately 34 seconds");
    result(report, "Ahmed source fixture", "PASS", { durationSeconds: Number(source.duration.toFixed(3)), videoCodec: source.videoCodec, audioCodec: source.audioCodec });

    // Deliberately headed: the only human step is entering the founder access
    // code in this browser. It is never read by this runner or written to disk.
    browser = await chromium.launch({ headless: false });
    desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    const page = await desktop.newPage();

    await page.goto(`${PRODUCTION_URL}/founder-test`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByLabel("Access code").waitFor({ state: "visible", timeout: 30_000 });
    console.log("Founder login required in the visible browser. Enter the access code once; the suite will continue automatically.");
    await page.waitForURL((url) => url.origin === PRODUCTION_URL && url.pathname === "/", { timeout: 5 * 60_000 });
    await page.getByRole("heading", { name: "What would you like to edit?" }).waitFor({ state: "visible" });
    result(report, "Founder gate login", "PASS");

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Video" }).click();
    await (await chooser).setFiles(sourceVideo);
    await page.getByRole("heading", { name: "Your target media" }).waitFor({ state: "visible", timeout: 30_000 });
    result(report, "Original Ahmed video upload", "PASS");

    await submitTurn(page, "Keep only the part where I talk about Ahmed Perfumes. Remove everything else.");
    await page.getByText("Your edit is ready.").waitFor({ state: "visible", timeout: 180_000 });
    const firstPreviewDuration = await waitForReady(page);
    const firstOutput = await downloadAndProbe(page, scratch, "ahmed-selection");
    result(report, "Ahmed Perfumes selection render", "PASS", { durationSeconds: Number(firstOutput.duration.toFixed(3)), previewDurationSeconds: Number(firstPreviewDuration.toFixed(3)) });
    result(report, "Ahmed Perfumes semantic/audio quality", "NOT VERIFIED", "requires founder final subjective review of the downloaded output");

    await submitTurn(page, "Now trim the first five seconds too.");
    await page.getByText(/Previous edit/).waitFor({ state: "visible", timeout: 30_000 });
    result(report, "Previous-edit label while follow-up renders", "PASS");
    await page.getByText("Trimmed the first 5 seconds from the current edit.").waitFor({ state: "visible", timeout: 180_000 });
    const trimPreviewDuration = await waitForReady(page);
    const trimOutput = await downloadAndProbe(page, scratch, "trimmed-selection");
    assert.ok(Math.abs(trimOutput.duration - (firstOutput.duration - 5)) < 1, "trim is five seconds relative to the previous output");
    assert.ok(trimOutput.duration >= 8 && trimOutput.duration <= 12, "trimmed Ahmed result is approximately ten seconds");
    assert.notEqual(trimOutput.firstFrame, firstOutput.firstFrame, "trimmed output begins at a different video frame");
    result(report, "Output-relative first-five-second trim", "PASS", { durationSeconds: Number(trimOutput.duration.toFixed(3)), previewDurationSeconds: Number(trimPreviewDuration.toFixed(3)) });

    await submitTurn(page, "Also add black and white.");
    await page.getByText("Applied black and white.").waitFor({ state: "visible", timeout: 180_000 });
    const bwOutput = await downloadAndProbe(page, scratch, "black-and-white");
    assert.ok(Math.abs(bwOutput.duration - trimOutput.duration) < 0.75, "black and white retains trims");
    result(report, "Black and white cumulative edit", "PASS", { durationSeconds: Number(bwOutput.duration.toFixed(3)) });

    await submitTurn(page, "Replace that with the cinematic style.");
    await page.getByText("Replaced the previous look with the cinematic style.").waitFor({ state: "visible", timeout: 180_000 });
    const cinematicOutput = await downloadAndProbe(page, scratch, "cinematic");
    assert.ok(Math.abs(cinematicOutput.duration - trimOutput.duration) < 0.75, "cinematic replacement retains trims");
    result(report, "Cinematic style replacement", "PASS", { durationSeconds: Number(cinematicOutput.duration.toFixed(3)) });

    await submitTurn(page, "Bring it back to normal.");
    await page.getByText("Restored the original color treatment while keeping your earlier edits.").waitFor({ state: "visible", timeout: 180_000 });
    const normalPreviewDuration = await waitForReady(page);
    const normalOutput = await downloadAndProbe(page, scratch, "normal");
    assert.ok(Math.abs(normalOutput.duration - trimOutput.duration) < 0.75, "normal reset retains trims");
    result(report, "Normal style restoration", "PASS", { durationSeconds: Number(normalOutput.duration.toFixed(3)), previewDurationSeconds: Number(normalPreviewDuration.toFixed(3)) });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Restored the original color treatment while keeping your earlier edits.").waitFor({ state: "visible", timeout: 60_000 });
    await waitForReady(page);
    result(report, "Conversation history and preview after refresh", "PASS");

    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByText(/Restored previous edit/).waitFor({ state: "visible", timeout: 60_000 });
    const undoOutput = await downloadAndProbe(page, scratch, "undo");
    assert.ok(Math.abs(undoOutput.duration - trimOutput.duration) < 0.75, "undo retains the trim");
    result(report, "Undo", "PASS", { durationSeconds: Number(undoOutput.duration.toFixed(3)) });

    const retainedSource = await page.locator("video.cliponaut-result-video").getAttribute("src");
    await submitTurn(page, "Make it amazing somehow.");
    const retainedError = page.locator(".cliponaut-preview-retained-error");
    await retainedError.waitFor({ state: "visible", timeout: 60_000 });
    assert.match(await retainedError.textContent(), /couldn.t safely|not supported|unsupported/i);
    assert.equal(await page.locator("video.cliponaut-result-video").getAttribute("src"), retainedSource, "failed follow-up retains prior preview");
    result(report, "Unsupported-instruction recovery", "PASS");

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(PRODUCTION_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await mobilePage.getByRole("heading", { name: "What would you like to edit?" }).waitFor({ state: "visible" });
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "mobile page does not overflow horizontally");
    await mobile.close();
    result(report, "Ordinary-user desktop/mobile shell", "PASS");
  } catch (error) {
    result(report, "Hosted acceptance execution", "FAIL", safeFailure(error));
    throw error;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Sanitized hosted report written to ${reportPath}`);
    await desktop?.close();
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const accessCode = process.env.FOUNDER_TEST_ACCESS_CODE;

if (!accessCode) throw new Error("FOUNDER_TEST_ACCESS_CODE is required for the local founder browser test");

async function waitForReady(page, expectedDuration) {
  await page.getByText("Ready", { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
  const video = page.locator("video.cliponaut-result-video");
  await video.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector("video.cliponaut-result-video");
    return element && element.readyState >= 1 && element.duration > 0;
  }, { timeout: 30_000 });
  const duration = await video.evaluate((element) => element.duration);
  assert.ok(Math.abs(duration - expectedDuration) < 0.35, `expected ${expectedDuration}s preview, received ${duration}s`);
  return { video, duration };
}

async function submitTurn(page, instruction) {
  const composer = page.getByLabel("Describe your video edit");
  await composer.fill(instruction);
  await page.getByRole("button", { name: "Generate" }).click();
}

test("founder browser acceptance: cumulative editing, refresh, undo, recovery and download", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-browser-"));
  const fixture = path.join(root, "fixture.mp4");
  const downloaded = path.join(root, "download.mp4");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await desktop.newPage();
  const baseURL = process.env.PHASE4_BROWSER_BASE_URL || "http://127.0.0.1:3100";
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture]);

    await page.goto(`${baseURL}/founder-test`);
    await page.getByLabel("Access code").fill(accessCode);
    await page.getByRole("button", { name: "Continue to Cliponaut" }).click();
    await page.getByRole("heading", { name: "What would you like to edit?" }).waitFor({ state: "visible" });

    // Use the visible control instead of injecting into the hidden input. This
    // exercises the same chooser path a founder uses and avoids a browser
    // implementation difference for visually-hidden multiple inputs.
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Video" }).click();
    await (await fileChooser).setFiles(fixture);
    await page.getByRole("heading", { name: "Your target media" }).waitFor({ state: "visible" });
    await submitTurn(page, "Make this video black and white.");
    // The upload-created first version uses the standard completion copy; later
    // session turns carry their explicit conversational confirmations.
    await page.getByText("Your edit is ready.").waitFor({ state: "visible", timeout: 90_000 });
    await waitForReady(page, 12);

    await submitTurn(page, "Now trim the first five seconds too.");
    await page.getByText(/Previous edit/).waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText("Trimmed the first 5 seconds from the current edit.").waitFor({ state: "visible", timeout: 90_000 });
    await waitForReady(page, 7);

    await submitTurn(page, "Replace that with the cinematic style.");
    await page.getByText("Replaced the previous look with the cinematic style.").waitFor({ state: "visible", timeout: 90_000 });
    await waitForReady(page, 7);

    await submitTurn(page, "Bring it back to normal.");
    await page.getByText("Restored the original color treatment while keeping your earlier edits.").waitFor({ state: "visible", timeout: 90_000 });
    await waitForReady(page, 7);

    await page.reload();
    await page.getByText("Restored the original color treatment while keeping your earlier edits.").waitFor({ state: "visible", timeout: 30_000 });
    await waitForReady(page, 7);

    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByText(/Restored previous edit/).waitFor({ state: "visible", timeout: 30_000 });
    await waitForReady(page, 7);

    const beforeFailure = await page.locator("video.cliponaut-result-video").getAttribute("src");
    await submitTurn(page, "Make it amazing somehow.");
    const retainedError = page.locator(".cliponaut-preview-retained-error");
    await retainedError.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await retainedError.textContent(), /couldn.t safely|not supported|unsupported/i);
    await page.locator("video.cliponaut-result-video").waitFor({ state: "visible" });
    assert.equal(await page.locator("video.cliponaut-result-video").getAttribute("src"), beforeFailure, "unsupported follow-up retains the prior playable preview");

    const href = await page.getByRole("link", { name: "Download MP4" }).getAttribute("href");
    assert.ok(href, "completed preview provides an MP4 download link");
    const response = await page.request.get(href);
    assert.equal(response.status(), 200);
    await writeFile(downloaded, await response.body());
    const probe = JSON.parse((await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type", "-of", "json", downloaded])).stdout);
    assert.match(probe.format.format_name, /mp4/);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "video"));
    assert.ok(Math.abs(Number(probe.format.duration) - 7) < 0.35);

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(baseURL);
    await mobilePage.getByRole("heading", { name: "What would you like to edit?" }).waitFor({ state: "visible" });
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, "mobile empty editor does not overflow horizontally");
    await mobile.close();
  } finally {
    await desktop.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

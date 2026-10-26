import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";

const reviewDirectory = process.env.PHASE4_HOSTED_REVIEW_DIR;
const reportPath = path.resolve(process.env.PHASE4_HOSTED_MEDIA_REPORT_PATH || path.join(os.tmpdir(), "cliponaut-hosted-phase4-media-report.json"));

async function playback(engine, file, playerUrl) {
  const browser = await chromium.launch(engine.launch);
  try {
    const page = await browser.newPage();
    await page.goto(`${playerUrl}#${encodeURIComponent(pathToFileURL(file).href)}`, { waitUntil: "domcontentloaded" });
    const ready = await page.waitForFunction(() => {
      const media = document.querySelector("video");
      return Boolean(media && media.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(media.duration) && media.duration > 0);
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
    return await page.locator("video").evaluate((media) => ({
      ok: ready,
      readyState: media.readyState,
      networkState: media.networkState,
      errorCode: media.error?.code || null,
      durationSeconds: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null
    }));
  } finally {
    await browser.close();
  }
}

test("local review MP4 playback: bundled Chromium versus stable Google Chrome", { timeout: 3 * 60_000 }, async () => {
  assert.ok(reviewDirectory, "PHASE4_HOSTED_REVIEW_DIR is required");
  const files = (await readdir(reviewDirectory))
    .filter((entry) => entry.endsWith(".mp4"))
    .map((entry) => path.join(reviewDirectory, entry));
  assert.ok(files.length >= 4, "review directory must contain the retained hosted MP4s");

  const report = { suite: "hosted-phase4-media-playback", target: "local-file-playback", generatedAt: new Date().toISOString(), engines: [] };
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cliponaut-hosted-media-player-"));
  const player = path.join(scratch, "player.html");
  await writeFile(player, "<video muted playsinline controls></video><script>const v=document.querySelector('video');v.src=decodeURIComponent(location.hash.slice(1));v.load();</script>");
  const playerUrl = pathToFileURL(player).href;
  const engines = [
    { name: "playwright-bundled-chromium", launch: { headless: true, args: ["--allow-file-access-from-files"] } },
    { name: "stable-google-chrome", launch: { channel: "chrome", headless: true, args: ["--allow-file-access-from-files"] } }
  ];
  try {
    for (const engine of engines) {
      const outputs = [];
      for (const file of files) {
        try {
          const state = await playback(engine, file, playerUrl);
          outputs.push({ file: path.basename(file), ...state });
        } catch (error) {
          outputs.push({ file: path.basename(file), ok: false, error: error?.name || "launch error" });
        }
      }
      report.engines.push({ name: engine.name, outputs });
    }
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rm(scratch, { recursive: true, force: true });
  }

  const chrome = report.engines.find((engine) => engine.name === "stable-google-chrome");
  assert.ok(chrome?.outputs.length, "stable Google Chrome launched");
  assert.ok(chrome.outputs.every((output) => output.ok), "stable Google Chrome plays every retained MP4");
});

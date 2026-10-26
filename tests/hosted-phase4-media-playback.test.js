import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";

const reviewDirectory = process.env.PHASE4_HOSTED_REVIEW_DIR;
const reportPath = path.resolve(process.env.PHASE4_HOSTED_MEDIA_REPORT_PATH || path.join(os.tmpdir(), "cliponaut-hosted-phase4-media-report.json"));
const chromeHeaded = process.env.PHASE4_HOSTED_MEDIA_HEADED !== "0";

function safeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: String(error?.message || "unknown error")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/file:\/\/\S+/gi, "[file]")
      .replace(/\/?Users\/[^\s)]+/g, "[path]")
      .replace(/\/?private\/[^\s)]+/g, "[path]")
      .slice(0, 240)
  };
}

async function startMediaServer(media, report) {
  const byId = new Map(media.map((entry) => [entry.id, entry]));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const player = pathname.match(/^\/player\/(review-\d+)$/);
    if (player && byId.has(player[1])) {
      const id = player[1];
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><video id="player" muted playsinline controls src="/media/${id}"></video><script>const v=document.querySelector('video');window.phase4Events={loadedmetadata:false,error:false,stalled:false,canplay:false};for(const e of Object.keys(window.phase4Events))v.addEventListener(e,()=>window.phase4Events[e]=true);</script>`);
      return;
    }
    const mediaRequest = pathname.match(/^\/media\/(review-\d+)$/);
    if (!mediaRequest || !byId.has(mediaRequest[1])) {
      response.writeHead(404).end();
      return;
    }
    const entry = byId.get(mediaRequest[1]);
    const size = (await stat(entry.file)).size;
    const range = request.headers.range;
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (!match) { response.writeHead(416).end(); return; }
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) { response.writeHead(416).end(); return; }
      status = 206;
    }
    report.serverMedia.push({ label: entry.id, status, ranged: Boolean(range), mimeType: "video/mp4" });
    response.writeHead(status, {
      "content-type": "video/mp4",
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {})
    });
    createReadStream(entry.file, { start, end }).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function inspectMedia(page, url) {
  try {
    const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (navigation?.status() !== 200) return { ok: false, stage: "navigation", navigationStatus: navigation?.status() || null };
  } catch (error) {
    return { ok: false, stage: "navigation", error: safeError(error) };
  }
  const video = page.locator("video#player");
  try {
    await video.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => {
      const media = document.querySelector("video#player");
      return Boolean(media && media.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(media.duration) && media.duration > 0);
    }, null, { timeout: 15_000 });
  } catch (error) {
    const state = await video.evaluate((media) => ({ readyState: media.readyState, networkState: media.networkState, errorCode: media.error?.code || null, durationSeconds: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null, events: window.phase4Events }));
    return { ok: false, stage: "media-metadata", ...state, error: safeError(error) };
  }
  try {
    await video.evaluate((media) => media.play());
    await page.waitForFunction(() => document.querySelector("video#player")?.currentTime > 0.2, null, { timeout: 10_000 });
  } catch (error) {
    const state = await video.evaluate((media) => ({ readyState: media.readyState, networkState: media.networkState, errorCode: media.error?.code || null, durationSeconds: Number(media.duration.toFixed(3)), events: window.phase4Events }));
    return { ok: false, stage: "media-playback", ...state, error: safeError(error) };
  }
  return video.evaluate((media) => ({ ok: true, stage: "playback", readyState: media.readyState, networkState: media.networkState, errorCode: media.error?.code || null, durationSeconds: Number(media.duration.toFixed(3)), events: window.phase4Events, canPlayH264: media.canPlayType('video/mp4; codecs="avc1.42E01E"'), canPlayAac: media.canPlayType('audio/mp4; codecs="mp4a.40.2"') }));
}

async function runEngine(engine, media, origin) {
  let browser;
  try {
    browser = await chromium.launch(engine.launch);
  } catch (error) {
    return { name: engine.name, launch: { ok: false, error: safeError(error) }, outputs: [] };
  }
  try {
    const outputs = [];
    for (const entry of media) {
      const page = await browser.newPage();
      outputs.push({ label: entry.id, ...(await inspectMedia(page, `${origin}/player/${entry.id}`)) });
      await page.close();
    }
    return { name: engine.name, launch: { ok: true, version: browser.version() }, outputs };
  } finally {
    await browser.close();
  }
}

test("local review MP4 playback: bundled Chromium versus stable Google Chrome", { timeout: 3 * 60_000 }, async () => {
  assert.ok(reviewDirectory, "PHASE4_HOSTED_REVIEW_DIR is required");
  const files = (await readdir(reviewDirectory)).filter((entry) => entry.endsWith(".mp4")).map((entry) => path.join(reviewDirectory, entry));
  assert.ok(files.length >= 4, "review directory must contain the retained hosted MP4s");

  const report = { suite: "hosted-phase4-media-playback", target: "local-loopback-playback", generatedAt: new Date().toISOString(), engines: [], serverMedia: [] };
  const media = files.map((file, index) => ({ id: `review-${index + 1}`, file }));
  const { server, origin } = await startMediaServer(media, report);
  const engines = [
    { name: "playwright-bundled-chromium", launch: { headless: true } },
    { name: "stable-google-chrome", launch: { channel: "chrome", headless: !chromeHeaded } }
  ];
  try {
    for (const engine of engines) report.engines.push(await runEngine(engine, media, origin));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const chrome = report.engines.find((engine) => engine.name === "stable-google-chrome");
  assert.equal(chrome?.launch.ok, true, "stable Google Chrome launches");
  assert.ok(chrome.outputs.length >= 4, "stable Google Chrome navigates to every local player");
  assert.ok(chrome.outputs.every((output) => output.ok), "stable Google Chrome plays every retained MP4");
});

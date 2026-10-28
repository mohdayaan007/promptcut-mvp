import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";

// This is intentionally public and read-only: no authentication, uploads,
// prompts, editing-session requests, or media downloads are performed.
const enabled = process.env.PHASE4_HOSTED_READONLY === "1";
const target = "https://cliponaut.com";
const reportPath = path.resolve(process.env.PHASE4_HOSTED_READONLY_REPORT_PATH || path.join(os.tmpdir(), "cliponaut-phase4-readonly-report.json"));

function result(report, name, status, detail = undefined) { report.checks.push({ name, status, ...(detail ? { detail } : {}) }); }
function safeError(error) { return error?.name === "AssertionError" ? "assertion failed" : (error?.name || "unknown error"); }

async function assertOrdinaryPage(page, label) {
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "What would you like to edit?" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Upload Video" }).waitFor({ state: "visible" });
  assert.equal(await page.getByLabel("Access code").count(), 0, `${label} ordinary editor does not expose founder login`);
  assert.equal(await page.getByText("Founder-only conversational editing").count(), 0, `${label} ordinary editor does not expose founder-only UI`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${label} has no horizontal overflow`);
}

test("hosted public Phase 4 gate and responsive shell are read-only", { timeout: 3 * 60_000, skip: !enabled }, async () => {
  const report = { suite: "hosted-phase4-readonly", target, generatedAt: new Date().toISOString(), checks: [] };
  let browser;
  try {
    await mkdir(path.dirname(reportPath), { recursive: true });
    browser = await chromium.launch({ channel: "chrome", headless: false });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const desktopPage = await desktop.newPage();
    await assertOrdinaryPage(desktopPage, "desktop");
    result(report, "Ordinary desktop editor shell", "PASS");

    await desktopPage.goto(`${target}/founder-test`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await desktopPage.getByLabel("Access code").waitFor({ state: "visible", timeout: 30_000 });
    result(report, "Founder gate requires browser-local access code", "PASS");
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobile.newPage();
    await assertOrdinaryPage(mobilePage, "mobile");
    result(report, "Ordinary mobile editor shell", "PASS");
    await mobile.close();
  } catch (error) {
    result(report, "Read-only hosted verification", "FAIL", safeError(error));
    throw error;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close();
  }
});

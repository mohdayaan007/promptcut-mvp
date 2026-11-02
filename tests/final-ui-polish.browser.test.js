import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "@playwright/test";

const base = process.env.CLIPONAUT_UI_TEST_URL || "http://127.0.0.1:3217";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("UI tests require an isolated local server");
const artifacts = process.env.CLIPONAUT_UI_ARTIFACTS;
const period = { start: new Date(Date.now() - 3600000).toISOString(), end: new Date(Date.now() + 30 * 86400000).toISOString() };
const usage = { allowance: 15, billingPeriod: period, successfulRenders: 1, reservedRenders: 0, remainingRenders: 14 };

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`${label}: legacy editor redirects to the existing modern workspace`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport });
      await page.route("**/*", route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
      const response = await page.goto(`${base}/editor`);
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(response.status(), 200);
      assert.equal(response.request().redirectedFrom()?.url(), `${base}/editor`);
      await page.locator("main").waitFor();
      assert.ok(await page.locator("main").innerText());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      if (artifacts) { await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: `${artifacts}/${label}-editor.png`, fullPage: true, animations: "disabled" }); }
    } finally { await browser.close(); }
  });

  for (const state of ["active", "scheduled", "unverified", "pending"]) {
    test(`${label}: ${state} account and cancellation presentation`, async () => {
      const browser = await chromium.launch({ headless: true });
      let mutations = 0;
      try {
        const page = await browser.newPage({ viewport });
        await page.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== new URL(base).origin) return route.abort();
          if (!url.pathname.startsWith("/api/")) return route.continue();
          if (request.method() !== "GET") { mutations++; return route.abort(); }
          const cancellation = { enabled: true, state: state === "scheduled" ? "scheduled" : state === "pending" ? "pending" : "none", periodEnd: state === "unverified" ? null : period.end };
          const account = { signedIn: true, email: "founder@example.test", subscriptionStatus: state === "scheduled" ? "cancellation_scheduled" : "active", cancellation };
          if (state === "scheduled") account.cancellation.recovery = { state: "unresolved" };
          const body = url.pathname === "/api/auth/session" ? account : url.pathname === "/api/account/usage" ? (state === "unverified" ? null : usage) : {};
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        });
        await page.goto(`${base}/account`);
        await page.getByRole("heading", { name: "founder@example.test" }).waitFor();
        if (state !== "unverified") await page.getByText("14 render slots remain in this verified billing period.", { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        if (state === "active") {
          await page.getByText("Your current paid billing period is verified.", { exact: true }).waitFor();
          assert.equal(await page.getByText(/We still verify current billing-period evidence/).count(), 0);
          if (artifacts) await page.screenshot({ path: `${artifacts}/${label}-active.png`, fullPage: true, animations: "disabled" });
          await page.getByRole("button", { name: "Cancel subscription", exact: true }).click();
          const keep = page.getByRole("button", { name: "Keep subscription", exact: true });
          const confirm = page.getByRole("button", { name: "Confirm cancellation", exact: true });
          assert.equal(await keep.evaluate(el => document.activeElement === el), true, "safe action receives initial focus");
          const safe = await keep.boundingBox(), destructive = await confirm.boundingBox();
          assert.ok(safe.height >= 44 && destructive.height >= 44);
          assert.ok(destructive.x >= safe.x + safe.width + 11 || destructive.y >= safe.y + safe.height + 11, "actions have a visible gap");
          assert.notEqual(await keep.evaluate(el => getComputedStyle(el).backgroundColor), await confirm.evaluate(el => getComputedStyle(el).backgroundColor));
          if (artifacts) await page.screenshot({ path: `${artifacts}/${label}-confirmation.png`, fullPage: true, animations: "disabled" });
          await keep.press("Enter");
          assert.equal(await page.getByRole("group", { name: "Confirm subscription cancellation" }).count(), 0);
        } else if (state === "scheduled") {
          assert.equal(await page.getByText("Cancellation scheduled", { exact: true }).count(), 1);
          await page.getByText(/Future renewal has stopped/).waitFor();
          assert.equal(await page.getByRole("button", { name: /cancel subscription|confirm cancellation/i }).count(), 0);
          assert.equal(await page.getByText("Cancellation requires review", { exact: true }).count(), 0);
          assert.ok(await page.getByText(/Future renewal has stopped/).locator("strong").innerText(), "verified access-end date is shown");
          if (artifacts) await page.screenshot({ path: `${artifacts}/${label}-scheduled.png`, fullPage: true, animations: "disabled" });
        } else if (state === "unverified") {
          await page.getByText("We still verify current billing-period evidence before enabling a new render.", { exact: true }).waitFor();
          await page.getByRole("heading", { name: "Usage unavailable" }).waitFor();
          await page.getByRole("button", { name: "Cancel subscription", exact: true }).click();
          assert.equal(await page.getByRole("button", { name: "Confirm cancellation", exact: true }).isDisabled(), true);
          assert.equal(await page.getByText("Your current paid billing period is verified.", { exact: true }).count(), 0);
        } else {
          await page.getByText("Renewal has not yet been confirmed stopped.", { exact: false }).waitFor();
          assert.equal(await page.getByText(/Future renewal has stopped/).count(), 0);
        }
        assert.equal(mutations, 0, "presentation and safe action cause no provider or billing mutation");
      } finally { await browser.close(); }
    });
  }
}

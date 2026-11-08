import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";

const base = process.env.CLIPONAUT_UI_TEST_URL || "http://127.0.0.1:3218";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Isolated local UI server required");

for (const [name, viewport] of [["desktop", {width:1440,height:1000}], ["mobile", {width:390,height:844}]]) {
  for (const founder of [true, false]) {
    test(`${name}: ${founder ? "unlimited founder" : "quota-limited customer"} presentation on patched Next`, async () => {
      const browser = await chromium.launch({headless:true, ...(process.env.CLIPONAUT_BROWSER_CHANNEL ? {channel:process.env.CLIPONAUT_BROWSER_CHANNEL} : {})});
      let mutations = 0;
      try {
        const context = await browser.newContext({viewport});
        const period = {start:new Date(Date.now()-3600000).toISOString(),end:new Date(Date.now()+86400000).toISOString()};
        const usage = {allowance:15,billingPeriod:period,successfulRenders:1,reservedRenders:0,remainingRenders:14,founderUnlimited:founder};
        const account = {signedIn:true,email:"isolated-owner@example.test",subscriptionStatus:founder ? "expired" : "active",cancellation:{enabled:false,state:"none",periodEnd:null}};
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (!["GET","HEAD"].includes(request.method())) { mutations++;return route.abort(); }
          if (url.origin !== new URL(base).origin) return route.abort();
          if (!url.pathname.startsWith("/api/")) return route.continue();
          const body = url.pathname === "/api/auth/session" ? account : url.pathname === "/api/account/usage" ? usage : url.pathname === "/api/editor-access" ? {enforced:true,...account,usage,founderUnlimited:founder,eligible:true} : {};
          return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
        });
        const page = await context.newPage();
        await page.goto(`${base}/editor`);
        assert.equal(new URL(page.url()).pathname,"/");
        await page.locator(".cliponaut-editor-access").getByText(founder ? "Unlimited founder access" : "14 render slots available", {exact:true}).waitFor();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.goto(`${base}/account`);
        await page.getByRole("heading",{name:"isolated-owner@example.test"}).waitFor();
        if (founder) {
          await page.getByRole("heading",{name:"Unlimited renders",exact:true}).waitFor();
          assert.equal(await page.getByText("Subscription expired",{exact:true}).count(),0);
          assert.equal(await page.getByRole("button",{name:/subscribe|checkout|purchase/i}).count(),0);
        } else {
          await page.getByText("Your current paid billing period is verified.",{exact:true}).waitFor();
          await page.getByText("14 render slots remain in this verified billing period.",{exact:true}).waitFor();
          assert.equal(await page.getByRole("heading",{name:"Unlimited renders",exact:true}).count(),0);
        }
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if (process.env.CLIPONAUT_UI_ARTIFACTS) await page.screenshot({path:`${process.env.CLIPONAUT_UI_ARTIFACTS}/${name}-${founder ? "founder" : "customer"}.png`,fullPage:true,animations:"disabled"});
        assert.equal(mutations,0);
      } finally { await browser.close(); }
    });
  }
}

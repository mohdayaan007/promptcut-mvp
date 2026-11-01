import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import { STYLE_PROFILE_IDS } from "@/lib/editor-core/style-profiles";
import { dodoModeConfig, DodoConfigurationError } from "@/lib/dodo-config";
import { POST as checkout } from "@/app/api/billing/dodo/customer-checkout/route";

test("production retains all seven accepted style profiles and executor", () => {
  assert.deepEqual(STYLE_PROFILE_IDS, ["clean_commercial", "warm_travel", "cinematic", "soft_nostalgic", "vibrant_social", "dark_moody", "natural_documentary"]);
  const bytes = fs.readFileSync("src/lib/editor-core/style-profiles.js");
  assert.equal(crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex"), "787d5ba2fc01bcbdfaae523b6b18fde69674fc9c");
});

test("public pricing is $5 recurring with 15 verified paid-period renders", () => {
  for (const path of ["src/app/pricing/page.js", "src/app/terms/page.js", "src/app/refunds/page.js", "src/components/cliponaut/CheckoutButton.js"]) {
    const source = fs.readFileSync(path, "utf8");
    assert.ok(source.includes("$5"), path);
    assert.equal(source.includes("$6"), false, path);
    assert.ok(source.includes("15 successful renders"), path);
  }
  assert.match(fs.readFileSync("src/app/pricing/page.js", "utf8"), /verified paid billing period/);
  assert.match(fs.readFileSync("src/components/cliponaut/MarketingLayout.js", "utf8"), /href="\/safety"/);
});

test("Live configuration rejects accidentally reused Test product or brand pins", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { DODO_ENVIRONMENT: "live", DODO_LIVE_MODE_ENABLED: "true", DODO_LIVE_API_KEY: "dodo_live_fixture", DODO_LIVE_WEBHOOK_SECRET: "live-fixture-independent", DODO_TEST_WEBHOOK_SECRET: "test-fixture-independent", DODO_LIVE_CLIPONAUT_PRODUCT_ID: "pdt_0Nr1dKa0axNc4wD0dg8c4", DODO_TEST_CLIPONAUT_PRODUCT_ID: "pdt_0NqfvnCmCW8YiifWlVCLT", DODO_LIVE_BRAND_ID: "brnd_0NqfnWquQ3BudsIBEK782", DODO_TEST_BRAND_ID: "brnd_0NqfsdlaHQ5sYFSeq7gy3", DODO_LIVE_BUSINESS_ID: "bus_0NdkBSex5ZRNxaB4G66cb", DODO_LIVE_RETURN_URL: "https://cliponaut.com/account", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15" });
    assert.equal(dodoModeConfig().productId, "pdt_0Nr1dKa0axNc4wD0dg8c4");
    process.env.DODO_LIVE_CLIPONAUT_PRODUCT_ID = process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID;
    assert.throws(dodoModeConfig, DodoConfigurationError);
    process.env.DODO_LIVE_CLIPONAUT_PRODUCT_ID = "pdt_0Nr1dKa0axNc4wD0dg8c4";
    process.env.DODO_LIVE_BRAND_ID = process.env.DODO_TEST_BRAND_ID;
    assert.throws(dodoModeConfig, DodoConfigurationError);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("production checkout rejects anonymous and foreign-origin requests before provider access", async () => {
  const saved = { ...process.env }, previousFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    Object.assign(process.env, { DODO_ENVIRONMENT: "test", DODO_TEST_CUSTOMER_CHECKOUT_ENABLED: "true", CUSTOMER_CHECKOUT_ORIGIN: "https://cliponaut.com" });
    globalThis.fetch = async () => { providerCalls++; throw new Error("No provider calls permitted"); };
    const request = origin => new Request("http://localhost:8080/api/billing/dodo/customer-checkout", { method: "POST", headers: { origin, "x-forwarded-host": "cliponaut.com", "x-forwarded-proto": "https" } });
    assert.equal((await checkout(request("https://cliponaut.com"))).status, 401);
    assert.equal((await checkout(request("https://foreign.example"))).status, 403);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

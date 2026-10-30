import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { editorAccessState } from "@/lib/editor-access-presentation";

const period = { billingPeriod: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" }, remainingRenders: 4 };

test("paid flag off preserves the existing editor flow", () => {
  assert.equal(editorAccessState({ phase: "ready", enforced: false }).blocking, false);
});

test("paid editor states safely block ineligible customers and permit eligible customers", () => {
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: false }).title, "Sign in to edit");
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus: "not_subscribed" }).href, "/pricing");
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus: "pending_verification" }).title, "Checkout pending verification");
  for (const subscriptionStatus of ["past_due", "cancelled", "expired"]) assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus }).blocking, true);
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus: "active", usage: period }).blocking, false);
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus: "active", usage: { ...period, remainingRenders: 0 } }).title, "Render allowance used");
  assert.equal(editorAccessState({ phase: "ready", enforced: true, signedIn: true, subscriptionStatus: "active", usage: null }).title, "Editing availability unavailable");
});

test("network uncertainty does not invent eligibility and keeps server enforcement authoritative", () => {
  const state = editorAccessState({ phase: "error" });
  assert.equal(state.action, "retry"); assert.equal(state.blocking, false);
  assert.match(state.detail, /checked securely/i);
});

test("customer editor integration leaves existing 4K eligibility computation intact", () => {
  const page = fs.readFileSync(new URL("../src/app/page.js", import.meta.url), "utf8");
  assert.match(page, /const canExport4k = videos\.length > 0 && videoMetadata\.length === videos\.length && videoMetadata\.every\(is4kCapable\)/);
  assert.match(page, /onExportQualityChange=\{setExportQuality\}/);
});

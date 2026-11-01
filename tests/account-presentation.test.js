import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { accountState, billingPeriodState, cancellationManagementState, cancellationUiState, createCancellationRequestGuard, editingReadiness, performLogout, usageState } from "@/lib/account-presentation";

test("account presentation covers subscription and unavailable usage states", () => {
  for (const status of ["not_subscribed", "pending_verification", "active", "past_due", "cancelled", "expired"]) assert.ok(accountState(status).title);
  assert.equal(accountState("unknown").title, accountState("not_subscribed").title);
  assert.deepEqual(usageState(null), { available: false, timing: "unavailable" });
  assert.deepEqual(usageState({ allowance: 15, billingPeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }, successfulRenders: 2, reservedRenders: 1, remainingRenders: 12 }, Date.parse("2026-01-15T00:00:00.000Z")), { available: true, timing: "current", allowance: 15, billingPeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }, successfulRenders: 2, reservedRenders: 1, remainingRenders: 12 });
});

test("editing readiness requires a current verified period and remaining capacity", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z"); const current = { allowance: 15, billingPeriod: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" }, successfulRenders: 2, reservedRenders: 1, remainingRenders: 12 };
  assert.equal(editingReadiness("active", null, now).title, "Editing availability unavailable");
  assert.equal(billingPeriodState({ ...current, billingPeriod: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } }, now).timing, "future");
  assert.equal(editingReadiness("active", { ...current, billingPeriod: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" } }, now).title, "No current verified billing period");
  assert.equal(editingReadiness("active", { ...current, billingPeriod: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" } }, now).title, "No current verified billing period");
  assert.equal(editingReadiness("active", { ...current, remainingRenders: 0 }, now).title, "Render allowance used");
  assert.equal(editingReadiness("active", current, now).title, "New renders available");
});

test("logout confirmation preserves authenticated state on HTTP and network failures", async () => {
  await assert.rejects(() => performLogout(async () => new Response(null, { status: 500 })), /could not sign you out/i);
  await assert.rejects(() => performLogout(async () => { throw new Error("network down"); }), /network down/);
  assert.equal(await performLogout(async () => new Response(null, { status: 204 })), true);
});

test("cancellation management only presents verified current-period state", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z"); const end = "2026-11-01T12:00:00.000Z";
  assert.deepEqual(cancellationManagementState({ enabled: false, state: "scheduled", periodEnd: end }, now), { enabled: false, state: "none", periodEnd: null });
  assert.deepEqual(cancellationManagementState({ enabled: true, state: "pending", periodEnd: end }, now), { enabled: true, state: "pending", periodEnd: end });
  assert.deepEqual(cancellationManagementState({ enabled: true, state: "scheduled", periodEnd: end }, now), { enabled: true, state: "scheduled", periodEnd: end });
  assert.deepEqual(cancellationManagementState({ enabled: true, state: "scheduled", periodEnd: "2026-10-01T12:00:00.000Z" }, now), { enabled: true, state: "none", periodEnd: null });
});

test("outstanding cancellation takes UI precedence and duplicate interactions are single-flight", () => {
  assert.equal(cancellationUiState("none", "loading"), "loading");
  assert.equal(cancellationUiState("none", "scheduled"), "scheduled");
  assert.equal(cancellationUiState("none", "pending"), "pending");
  assert.equal(cancellationUiState("none", "error"), "none");
  const guard = createCancellationRequestGuard();
  assert.equal(guard.start(), true, "the confirmed request may start once");
  assert.equal(guard.start(), false, "a rapid second confirmation cannot create another local POST");
  guard.finish();
  assert.equal(guard.start(), true, "settled requests retain the existing retry behavior");
});

function luminance(hex) { const values = hex.match(/[a-f\d]{2}/gi).map((value) => { const channel = parseInt(value, 16) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }); return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]; }
function contrast(foreground, background) { const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); }
test("checkout helper text meets AA contrast on light and dark surfaces", () => {
  const css = fs.readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.cliponaut-checkout-control p \{[^}]*color: #e2dbd2/); assert.match(css, /\.cliponaut-account-card \.cliponaut-checkout-control p \{ color: #554f49/);
  assert.ok(contrast("e2dbd2", "1d1c1a") >= 4.5); assert.ok(contrast("554f49", "fffdf9") >= 4.5);
});

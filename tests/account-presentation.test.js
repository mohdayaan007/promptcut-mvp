import assert from "node:assert/strict";
import test from "node:test";
import { accountState, usageState } from "@/lib/account-presentation";

test("account presentation covers subscription and unavailable usage states", () => {
  for (const status of ["not_subscribed", "pending_verification", "active", "past_due", "cancelled", "expired"]) assert.ok(accountState(status).title);
  assert.equal(accountState("unknown").title, accountState("not_subscribed").title);
  assert.deepEqual(usageState(null), { available: false });
  assert.deepEqual(usageState({ allowance: 15, billingPeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }, successfulRenders: 2, reservedRenders: 1, remainingRenders: 12 }), { available: true, allowance: 15, billingPeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }, successfulRenders: 2, reservedRenders: 1, remainingRenders: 12 });
});

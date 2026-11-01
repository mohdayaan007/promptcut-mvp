import assert from "node:assert/strict";
import test from "node:test";
import { createCancellationRecoveryMaintenance } from "@/lib/cancellation-recovery-maintenance";

test("recovery maintenance progresses during a blocked render without overlap, survives timeout, and stops safely", async () => {
  let releaseRender; const render = new Promise((resolve) => { releaseRender = resolve; }); let gets = 0; let concurrent = 0; let maxConcurrent = 0;
  const maintenance = createCancellationRecoveryMaintenance({ enabled: () => true, intervalMs: 5, reconcile: async () => { gets++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); try { if (gets === 1) await new Promise((_, reject) => setTimeout(() => reject(new Error("provider timeout")), 10)); else await Promise.resolve(); } finally { concurrent--; } } });
  const processing = render.then(() => "render-complete"); maintenance.start(); await maintenance.tick(); await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await Promise.race([processing, Promise.resolve("still-rendering")]), "still-rendering"); assert.ok(gets >= 2, "maintenance reconciles while render remains blocked"); assert.equal(maxConcurrent, 1, "ticks do not overlap");
  maintenance.stop(); const count = gets; await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(gets, count, "shutdown stops future maintenance"); releaseRender(); await processing;
});

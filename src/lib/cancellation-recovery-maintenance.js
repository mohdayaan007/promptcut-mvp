export function createCancellationRecoveryMaintenance({ enabled, reconcile, intervalMs = 60_000, onError = () => {} }) {
  let running = false; let stopped = false; let timer;
  async function tick() { if (stopped || running || !enabled()) return false; running = true; try { await reconcile(); return true; } catch (error) { onError(error); return false; } finally { running = false; } }
  return { tick, start() { if (!timer) timer = setInterval(() => { tick(); }, intervalMs); return timer; }, stop() { stopped = true; if (timer) clearInterval(timer); }, get running() { return running; } };
}

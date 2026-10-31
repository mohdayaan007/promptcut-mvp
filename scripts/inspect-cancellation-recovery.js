import { dodoTestCancellationRecoveryConfig, getDodoTestCancellationState } from "@/lib/dodo-test-mode";
import { closeJobStorePool, getCancellationRecoveryCaseForOperator, migrateEditJobs } from "@/lib/jobs/job-store";

function syntheticInspectionEvidence() {
  if (process.env.NODE_ENV !== "test" || !process.env.DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON) return null;
  try { return JSON.parse(process.env.DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON); } catch { throw new Error("Synthetic inspection evidence is invalid"); }
}

async function main() {
  const [caseId] = process.argv.slice(2);
  if (!process.env.FOUNDER_CANCELLATION_RECOVERY_OPERATOR) throw new Error("FOUNDER_CANCELLATION_RECOVERY_OPERATOR is required");
  await migrateEditJobs(); const recovery = await getCancellationRecoveryCaseForOperator(caseId);
  if (!recovery) throw new Error("Recovery case was not found");
  const config = dodoTestCancellationRecoveryConfig();
  if (recovery.product_id !== config.productId || recovery.business_id !== config.businessId || recovery.brand_id !== config.brandId || recovery.ownership_provenance !== "verified") throw new Error("Recovery case provenance does not match configured Cliponaut Test Mode");
  let provider = null; let providerError = null;
  try {
    provider = syntheticInspectionEvidence() || await getDodoTestCancellationState({ subscriptionId: recovery.subscription_id });
    const sameEvidence = provider?.subscriptionId === recovery.subscription_id && provider.customerId === recovery.dodo_customer_id
      && provider.productId === recovery.product_id && provider.brandId === recovery.brand_id && provider.businessId === recovery.business_id
      && new Date(provider.billingStart).getTime() === new Date(recovery.billing_period_start).getTime()
      && new Date(provider.billingEnd).getTime() === new Date(recovery.billing_period_end).getTime();
    if (!sameEvidence) throw new Error("Provider evidence does not match the immutable recovery case");
  } catch (error) { providerError = error.message === "Provider evidence does not match the immutable recovery case" ? error.message : "Provider evidence is unavailable or inconclusive"; }
  console.log(JSON.stringify({ caseId: recovery.id, state: recovery.state, renewalDeadline: recovery.billing_period_end, lastVerifiedAt: recovery.last_verified_at, provider, providerError }, null, 2));
  if (providerError) process.exitCode = 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => closeJobStorePool());

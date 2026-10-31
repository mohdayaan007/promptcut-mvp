import { dodoTestCancellationRecoveryConfig, getDodoTestCancellationState } from "@/lib/dodo-test-mode";
import { getCancellationRecoveryCaseForOperator, migrateEditJobs } from "@/lib/jobs/job-store";

const [caseId] = process.argv.slice(2);
if (!process.env.FOUNDER_CANCELLATION_RECOVERY_OPERATOR) throw new Error("FOUNDER_CANCELLATION_RECOVERY_OPERATOR is required");
await migrateEditJobs();
const recovery = await getCancellationRecoveryCaseForOperator(caseId);
if (!recovery) throw new Error("Recovery case was not found");
const config = dodoTestCancellationRecoveryConfig();
if (recovery.product_id !== config.productId || recovery.business_id !== config.businessId || recovery.brand_id !== config.brandId || recovery.ownership_provenance !== "verified") throw new Error("Recovery case provenance does not match configured Cliponaut Test Mode");
let provider = null; let providerError = null;
try { provider = await getDodoTestCancellationState({ subscriptionId: recovery.subscription_id }); } catch { providerError = "Provider evidence is unavailable or inconclusive"; }
console.log(JSON.stringify({ caseId: recovery.id, state: recovery.state, renewalDeadline: recovery.billing_period_end, lastVerifiedAt: recovery.last_verified_at, provider, providerError }, null, 2));

import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { listUnresolvedCancellationRecoveryCases } from "@/lib/jobs/job-store";
import { PublicRequestError, jsonError } from "@/lib/jobs/http";

export const runtime = "nodejs";
export async function GET(req) {
  try {
    if (!hasFounderTestAccess(req)) throw new PublicRequestError("Founder access is required.", 403);
    return Response.json({ cases: await listUnresolvedCancellationRecoveryCases() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

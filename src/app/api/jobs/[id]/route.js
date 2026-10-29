import { getAuthorizedJob, getJobConfirmation } from "@/lib/jobs/job-store";
import { signedDownloadUrl } from "@/lib/jobs/storage";
import { jsonError, jobToken, PublicRequestError, safeJobResponse, safeSourceMetadata } from "@/lib/jobs/http";
import { authorizePaidJob } from "@/lib/paid-editing";

export const runtime = "nodejs";

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const job = await authorizePaidJob(req, id, jobToken(req), { requireCurrentEntitlement: false }) || await getAuthorizedJob(id, jobToken(req));
    if (!job) return jsonError(new PublicRequestError("Edit job was not found", 404));
    const outputUrl = job.status === "completed" && job.outputKey && !job.outputCleanedAt ? await signedDownloadUrl(job.outputKey) : null;
    const confirmation = job.status === "completed" ? await getJobConfirmation(job.id) : null;
    return Response.json(safeJobResponse(job, {
      outputUrl,
      confirmation,
      sources: safeSourceMetadata(job.sources)
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

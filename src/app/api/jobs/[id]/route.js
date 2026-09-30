import { getAuthorizedJob } from "@/lib/jobs/job-store";
import { signedDownloadUrl } from "@/lib/jobs/storage";
import { jsonError, jobToken, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";

export const runtime = "nodejs";

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const job = await getAuthorizedJob(id, jobToken(req));
    if (!job) return jsonError(new PublicRequestError("Edit job was not found", 404));
    const outputUrl = job.status === "completed" && job.outputKey && !job.outputCleanedAt ? await signedDownloadUrl(job.outputKey) : null;
    return Response.json(safeJobResponse(job, { outputUrl }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

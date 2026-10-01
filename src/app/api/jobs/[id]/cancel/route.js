import { cancelAuthorizedJob } from "@/lib/jobs/job-store";
import { abortMultipartUpload } from "@/lib/jobs/storage";
import { jsonError, jobToken, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";

export const runtime = "nodejs";

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const result = await cancelAuthorizedJob(id, jobToken(req));
    if (!result) return jsonError(new PublicRequestError("Edit job was not found", 404));
    if (result.cancelled && result.job.sources.some((source) => source.uploadId)) {
      await Promise.all(result.job.sources.map((source) => abortMultipartUpload(source).catch(() => {})));
    }
    return Response.json(safeJobResponse(result.job), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

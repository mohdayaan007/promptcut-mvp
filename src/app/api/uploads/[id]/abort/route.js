import { abortMultipartUpload } from "@/lib/jobs/storage";
import { failUploadJob, getAuthorizedJob } from "@/lib/jobs/job-store";
import { jsonError, jobToken, PublicRequestError } from "@/lib/jobs/http";

export const runtime = "nodejs";

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const job = await getAuthorizedJob(id, jobToken(req));
    if (!job || job.status !== "uploading") return jsonError(new PublicRequestError("Upload session was not found", 404));
    await Promise.all(job.sources.map((source) => abortMultipartUpload(source)));
    await failUploadJob(id, "Upload was cancelled");
    return Response.json({ status: "failed" });
  } catch (error) {
    return jsonError(error);
  }
}

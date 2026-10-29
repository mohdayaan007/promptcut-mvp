import { createPartUploadUrls } from "@/lib/jobs/storage";
import { getAuthorizedJob } from "@/lib/jobs/job-store";
import { jsonError, jobToken, PublicRequestError } from "@/lib/jobs/http";
import { UPLOAD_URL_BATCH_SIZE } from "@/lib/jobs/job-config";
import { authorizePaidJob } from "@/lib/paid-editing";

export const runtime = "nodejs";

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const job = await authorizePaidJob(req, id, jobToken(req)) || await getAuthorizedJob(id, jobToken(req));
    if (!job || job.status !== "uploading") return jsonError(new PublicRequestError("Upload session was not found", 404));
    const { fileIndex, kind = "source", partNumbers } = await req.json();
    const source = kind === "reference" ? job.reference : job.sources.find((entry) => entry.index === fileIndex);
    if (!source || !source.uploadId || !Array.isArray(partNumbers) || !partNumbers.length || partNumbers.length > UPLOAD_URL_BATCH_SIZE || partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > 10_000)) {
      return jsonError(new PublicRequestError("Invalid upload part request"));
    }
    return Response.json({ parts: await createPartUploadUrls({ key: source.key, uploadId: source.uploadId, partNumbers }) });
  } catch (error) {
    return jsonError(error);
  }
}

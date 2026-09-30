import { abortMultipartUpload, completeMultipartUpload, headObject } from "@/lib/jobs/storage";
import { getAuthorizedJob, queueJob } from "@/lib/jobs/job-store";
import { jsonError, jobToken, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";
import { validateJobRequest, validateUploadManifest } from "@/lib/jobs/job-config";

export const runtime = "nodejs";

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const job = await getAuthorizedJob(id, jobToken(req));
    if (!job || job.status !== "uploading") return jsonError(new PublicRequestError("Upload session was not found", 404));
    const { prompt, exportQuality = "standard", files } = await req.json();
    if (!Array.isArray(files) || files.length !== job.sources.length) return jsonError(new PublicRequestError("Upload completion did not match the selected videos"));
    const sources = job.sources.map((source, index) => {
      const submitted = files[index];
      if (!submitted || submitted.key !== source.key || submitted.uploadId !== source.uploadId || !Array.isArray(submitted.parts) || !submitted.parts.length) {
        throw new PublicRequestError("Upload completion did not match the selected videos");
      }
      const parts = submitted.parts.map((part) => ({ ETag: String(part.eTag || "").replaceAll('"', ""), PartNumber: Number(part.partNumber) }));
      if (parts.some((part) => !part.ETag || !Number.isInteger(part.PartNumber) || part.PartNumber < 1)) throw new PublicRequestError("Upload completion contained invalid parts");
      return { ...source, parts };
    });
    try { validateUploadManifest(sources); validateJobRequest({ prompt, exportQuality, sources }); } catch (error) { throw new PublicRequestError(error.message); }
    for (const source of sources) {
      await completeMultipartUpload({ key: source.key, uploadId: source.uploadId, parts: source.parts });
      const object = await headObject(source.key);
      if (Number(object.ContentLength) !== source.size) throw new PublicRequestError("Uploaded file size could not be verified");
      delete source.uploadId;
      delete source.parts;
    }
    const queued = await queueJob(id, { prompt: prompt.trim(), exportQuality, sources });
    if (!queued) throw new PublicRequestError("This upload session can no longer be queued");
    return Response.json(safeJobResponse(queued));
  } catch (error) {
    return jsonError(error);
  }
}

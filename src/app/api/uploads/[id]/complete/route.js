import { abortMultipartUpload, completeMultipartUpload, headObject } from "@/lib/jobs/storage";
import { createEditingSession, getAuthorizedJob, queueJob } from "@/lib/jobs/job-store";
import { jsonError, jobToken, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";
import { validateJobRequest, validateReferenceManifest, validateUploadManifest } from "@/lib/jobs/job-config";
import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { authorizePaidJob } from "@/lib/paid-editing";

export const runtime = "nodejs";

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const job = await authorizePaidJob(req, id, jobToken(req)) || await getAuthorizedJob(id, jobToken(req));
    if (!job || job.status !== "uploading") return jsonError(new PublicRequestError("Upload session was not found", 404));
    const { prompt, exportQuality = "standard", files, reference: submittedReference } = await req.json();
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
    let reference = null;
    if (job.reference) {
      if (!submittedReference || submittedReference.key !== job.reference.key || submittedReference.uploadId !== job.reference.uploadId || !Array.isArray(submittedReference.parts) || !submittedReference.parts.length) {
        throw new PublicRequestError("Upload completion did not match the selected style reference");
      }
      const parts = submittedReference.parts.map((part) => ({ ETag: String(part.eTag || "").replaceAll('"', ""), PartNumber: Number(part.partNumber) }));
      if (parts.some((part) => !part.ETag || !Number.isInteger(part.PartNumber) || part.PartNumber < 1)) throw new PublicRequestError("Upload completion contained invalid reference parts");
      reference = { ...job.reference, parts };
    } else if (submittedReference) throw new PublicRequestError("Upload completion included an unexpected style reference");
    try { validateUploadManifest(sources); validateReferenceManifest(reference); validateJobRequest({ prompt, exportQuality, sources }); } catch (error) { throw new PublicRequestError(error.message); }
    for (const source of sources) {
      await completeMultipartUpload({ key: source.key, uploadId: source.uploadId, parts: source.parts });
      const object = await headObject(source.key);
      if (Number(object.ContentLength) !== source.size) throw new PublicRequestError("Uploaded file size could not be verified");
      delete source.uploadId;
      delete source.parts;
    }
    if (reference) {
      await completeMultipartUpload({ key: reference.key, uploadId: reference.uploadId, parts: reference.parts });
      const object = await headObject(reference.key);
      if (Number(object.ContentLength) !== reference.size) throw new PublicRequestError("Uploaded style reference size could not be verified");
      delete reference.uploadId;
      delete reference.parts;
    }
    const queued = await queueJob(id, { prompt: prompt.trim(), exportQuality, sources, reference });
    if (!queued) throw new PublicRequestError("This upload session can no longer be queued");
    // Conversational sessions are intentionally unavailable unless the
    // server-verified, short-lived founder test cookie is present. Ordinary
    // uploads keep their established single-edit response shape.
    const session = hasFounderTestAccess(req) ? await createEditingSession(queued.id, prompt.trim()) : null;
    return Response.json({ ...safeJobResponse(queued), ...(session ? { session } : {}) });
  } catch (error) {
    return jsonError(error);
  }
}

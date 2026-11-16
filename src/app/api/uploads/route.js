import { abortMultipartUpload, beginMultipartUpload, referenceObjectKey, sourceObjectKey } from "@/lib/jobs/storage";
import { createUploadJob, failUploadJob, releaseUnattachedRenderReservation, setUploadSources } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";
import { assertCustomerReferenceVideoUploadAllowed, MULTIPART_PART_SIZE_BYTES, referenceRequiresMultipartUpload, validateReferenceColourProfile, validateReferenceManifest, validateUploadManifest } from "@/lib/jobs/job-config";
import { authorizePaidEdit } from "@/lib/paid-editing";
import { customerMklRuntimeConfig } from "@/lib/editor-core/prepared-mkl-runtime";

export const runtime = "nodejs";

export async function POST(req) {
  let job;
  const started = [];
  let stage = "request parsing";
  let authorization;
  try {
    authorization = await authorizePaidEdit(req);
    const { files, reference: requestedReference, referenceProfile } = await req.json();
    let initialReference;
    try {
      validateUploadManifest(files);
      initialReference = validateReferenceManifest(requestedReference);
      assertCustomerReferenceVideoUploadAllowed(initialReference); if (initialReference && referenceProfile) throw new Error("Choose either an image reference or a local video profile"); initialReference ||= validateReferenceColourProfile(referenceProfile);
      if (initialReference?.kind === "video_profile") {
        // The client-side picker is not an authorization boundary.
        customerMklRuntimeConfig({ founderAuthorized: authorization.founderUnlimited === true });
      }
    } catch (error) { throw new PublicRequestError(error.message); }
    console.info("upload-session: request validated", { sourceCount: files.length });
    const initialSources = files.map((file, index) => ({ index, name: file.name, type: file.type, size: file.size }));
    stage = "database job creation";
    const created = await createUploadJob(initialSources, initialReference, { subscriberId: authorization.subscriberId, reservationId: authorization.reservationId });
    job = created.job;
    console.info("upload-session: database job created", { jobId: job.id, sourceCount: initialSources.length });
    const sources = [];
    for (const file of initialSources) {
      const key = sourceObjectKey(job.id, file.index);
      stage = "bucket multipart creation";
      console.info("upload-session: starting bucket multipart upload", { jobId: job.id, sourceIndex: file.index });
      const uploadId = await beginMultipartUpload({ key, contentType: file.type });
      started.push({ key, uploadId });
      sources.push({ ...file, key, uploadId, parts: [] });
    }
    // A browser-local profile is numerical job metadata, not uploadable media.
    // Preserve it in the job record without creating a bucket object.
    let reference = initialReference?.kind === "video_profile" ? initialReference : null;
    if (referenceRequiresMultipartUpload(initialReference)) {
      const key = referenceObjectKey(job.id, initialReference);
      stage = "reference bucket multipart creation";
      const uploadId = await beginMultipartUpload({ key, contentType: initialReference.type });
      started.push({ key, uploadId });
      reference = { ...initialReference, key, uploadId, parts: [] };
    }
    stage = "database upload-session update";
    await setUploadSources(job.id, sources, reference);
    console.info("upload-session: ready", { jobId: job.id, sourceCount: sources.length });
    return Response.json({
      ...safeJobResponse(job), accessToken: created.accessToken, partSize: MULTIPART_PART_SIZE_BYTES,
      uploads: sources.map(({ index, key, uploadId }) => ({ index, key, uploadId })),
      referenceUpload: reference ? { key: reference.key, uploadId: reference.uploadId } : null
    }, { status: 201 });
  } catch (error) {
    console.error("upload-session failed", {
      stage,
      jobId: job?.id || null,
      errorName: error?.name || "Error",
      errorCode: error?.code || error?.Code || null,
      httpStatus: error?.$metadata?.httpStatusCode || null,
      message: error instanceof Error ? error.message : "Unknown error"
    });
    await Promise.all(started.map((upload) => abortMultipartUpload(upload).catch(() => {})));
    if (job) await failUploadJob(job.id, "Upload could not be initialized").catch(() => {});
    else if (authorization?.enforced) await releaseUnattachedRenderReservation(authorization.reservationId, authorization.subscriberId).catch(() => {});
    return jsonError(error);
  }
}

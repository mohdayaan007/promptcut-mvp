import { abortMultipartUpload, beginMultipartUpload, sourceObjectKey } from "@/lib/jobs/storage";
import { createUploadJob, failUploadJob, setUploadSources } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";
import { MULTIPART_PART_SIZE_BYTES, validateUploadManifest } from "@/lib/jobs/job-config";

export const runtime = "nodejs";

export async function POST(req) {
  let job;
  const started = [];
  let stage = "request parsing";
  try {
    const { files } = await req.json();
    try { validateUploadManifest(files); } catch (error) { throw new PublicRequestError(error.message); }
    console.info("upload-session: request validated", { sourceCount: files.length });
    const initialSources = files.map((file, index) => ({ index, name: file.name, type: file.type, size: file.size }));
    stage = "database job creation";
    const created = await createUploadJob(initialSources);
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
    stage = "database upload-session update";
    await setUploadSources(job.id, sources);
    console.info("upload-session: ready", { jobId: job.id, sourceCount: sources.length });
    return Response.json({
      ...safeJobResponse(job), accessToken: created.accessToken, partSize: MULTIPART_PART_SIZE_BYTES,
      uploads: sources.map(({ index, key, uploadId }) => ({ index, key, uploadId }))
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
    return jsonError(error);
  }
}

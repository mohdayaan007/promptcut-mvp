import { abortMultipartUpload, beginMultipartUpload, sourceObjectKey } from "@/lib/jobs/storage";
import { createUploadJob, failUploadJob, setUploadSources } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError, safeJobResponse } from "@/lib/jobs/http";
import { MULTIPART_PART_SIZE_BYTES, validateUploadManifest } from "@/lib/jobs/job-config";

export const runtime = "nodejs";

export async function POST(req) {
  let job;
  const started = [];
  try {
    const { files } = await req.json();
    try { validateUploadManifest(files); } catch (error) { throw new PublicRequestError(error.message); }
    const initialSources = files.map((file, index) => ({ index, name: file.name, type: file.type, size: file.size }));
    const created = await createUploadJob(initialSources);
    job = created.job;
    const sources = [];
    for (const file of initialSources) {
      const key = sourceObjectKey(job.id, file.index);
      const uploadId = await beginMultipartUpload({ key, contentType: file.type });
      started.push({ key, uploadId });
      sources.push({ ...file, key, uploadId, parts: [] });
    }
    await setUploadSources(job.id, sources);
    return Response.json({
      ...safeJobResponse(job), accessToken: created.accessToken, partSize: MULTIPART_PART_SIZE_BYTES,
      uploads: sources.map(({ index, key, uploadId }) => ({ index, key, uploadId }))
    }, { status: 201 });
  } catch (error) {
    await Promise.all(started.map((upload) => abortMultipartUpload(upload).catch(() => {})));
    if (job) await failUploadJob(job.id, "Upload could not be initialized").catch(() => {});
    return jsonError(error);
  }
}

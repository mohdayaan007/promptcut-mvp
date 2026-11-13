import { Readable } from "node:stream";
import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { founderReferenceStyleStagingEnabled } from "@/lib/editor-core/founder-reference-style-staging-contract";
import { getFounderReferenceStyleOutputJob } from "@/lib/jobs/job-store";
import { founderLocalOutputStream, founderLocalStorageRoot } from "@/lib/jobs/storage";

export const runtime = "nodejs";

export async function GET(req, { params }) {
  if (!founderLocalStorageRoot() || !founderReferenceStyleStagingEnabled() || !hasFounderTestAccess(req)) return new Response(null, { status: 404 });
  const { id } = await params;
  const job = await getFounderReferenceStyleOutputJob(id);
  if (!job) return new Response(null, { status: 404 });
  try {
    const stream = await founderLocalOutputStream(job.outputKey);
    return new Response(Readable.toWeb(stream), { headers: { "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "Content-Disposition": "inline; filename=cliponaut-reference-style.mp4" } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

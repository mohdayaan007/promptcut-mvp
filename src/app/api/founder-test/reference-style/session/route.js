import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { createFounderReferenceStyleJob, createFounderReferenceStyleRevision, getAuthorizedSession, getFounderReferenceStyleComposition } from "@/lib/jobs/job-store";
import { founderReferenceStyleApprovedReferences, loadFounderReferenceStyleManifest } from "@/lib/founder-reference-style-assets";
import { founderReferenceStyleStagingEnabled } from "@/lib/editor-core/founder-reference-style-staging-contract";
import { applyReferenceStyleV1Revision, createReferenceStyleV1Composition } from "@/lib/editor-core/reference-style-v1-composition";

export const runtime = "nodejs";
function unavailable() { return Response.json({ error: "Not found" }, { status: 404 }); }
function title(value) { return typeof value === "string" && value.trim() && value.trim().length <= 48 ? value.trim() : null; }
function token(req) { return req.headers.get("x-cliponaut-session-token") || ""; }

export async function POST(req) {
  if (!hasFounderTestAccess(req) || !founderReferenceStyleStagingEnabled()) return unavailable();
  try {
    const body = await req.json();
    if (body.action === "create") {
      const value = title(body.title); if (!value) return Response.json({ error: "A short title is required." }, { status: 422 });
      const manifest = await loadFounderReferenceStyleManifest(body.referenceId);
      const composition = createReferenceStyleV1Composition({ title: value, profile: manifest.profile });
      const created = await createFounderReferenceStyleJob({ source: { index: 0, key: manifest.source.key, type: manifest.source.type, size: manifest.source.size, originalName: "founder-source.mp4", stagingAssetId: manifest.source.id }, reference: manifest.reference, profile: manifest.profile, composition, prompt: "Apply validated Reference Style." });
      return Response.json({ jobId: created.job.id, accessToken: created.accessToken, session: created.session, version: 1 }, { status: 201 });
    }
    if (body.action === "revise") {
      if (typeof body.sessionId !== "string" || !Number.isInteger(body.expectedVersion) || typeof body.request !== "string") return Response.json({ error: "The revision is invalid." }, { status: 422 });
      const session = await getAuthorizedSession(body.sessionId, token(req)); if (!session) return unavailable();
      const manifest = await loadFounderReferenceStyleManifest(current.profile.referenceAssetId);
      const current = await getFounderReferenceStyleComposition(session); if (!current) return unavailable();
      const historyJob = await createFounderReferenceStyleRevision(session, { expectedVersion: body.expectedVersion, composition: applyReferenceStyleV1Revision(current, body.request, manifest.source.duration), prompt: body.request.trim() });
      if (!historyJob) return Response.json({ error: "A newer revision already exists." }, { status: 409 });
      return Response.json({ jobId: historyJob.job.id, accessToken: historyJob.accessToken, version: historyJob.version });
    }
    return Response.json({ error: "The Reference Style action is unsupported." }, { status: 422 });
  } catch { return Response.json({ error: "Founder Reference Style is unavailable." }, { status: 503 }); }
}

export async function GET(req) {
  if (!hasFounderTestAccess(req) || !founderReferenceStyleStagingEnabled()) return unavailable();
  return Response.json({ source: "Gym Outside Test", references: founderReferenceStyleApprovedReferences() }, { headers: { "Cache-Control": "no-store" } });
}

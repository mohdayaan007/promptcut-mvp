import { applyConversationTurn, validateConversationPlan } from "@/lib/editor-core/conversation-state";
import { createConversationJob, getAuthorizedSession, getSessionHistory } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { signedDownloadUrl } from "@/lib/jobs/storage";

export const runtime = "nodejs";

function token(req) { return req.headers.get("x-cliponaut-session-token") || ""; }

async function historyResponse(session) {
  const history = await getSessionHistory(session.id);
  return Promise.all(history.map(async (version) => ({
    version: version.version, jobId: version.job_id, prompt: version.prompt, confirmation: version.confirmation,
    status: version.status, createdAt: version.created_at,
    outputUrl: version.status === "completed" && version.output_key && !version.output_cleaned_at ? await signedDownloadUrl(version.output_key) : null
  })));
}

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const session = await getAuthorizedSession(id, token(req));
    if (!session) throw new PublicRequestError("Editing session was not found", 404);
    return Response.json({ id: session.id, latestVersion: session.latest_version, history: await historyResponse(session) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const session = await getAuthorizedSession(id, token(req));
    if (!session) throw new PublicRequestError("Editing session was not found", 404);
    const { prompt, expectedVersion } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1000) throw new PublicRequestError("Enter an editing instruction");
    if (!Number.isInteger(expectedVersion)) throw new PublicRequestError("The editing session version is invalid.");
    const history = await getSessionHistory(session.id);
    const current = [...history].reverse().find((version) => version.status === "completed" && version.plan && Array.isArray(version.source_catalog));
    if (!current) throw new PublicRequestError("Wait for a successful edit before making another change.", 409);
    const { plan, confirmation } = applyConversationTurn({ priorPlan: current.plan, prompt: prompt.trim(), sourceCatalog: current.source_catalog });
    validateConversationPlan(plan, current.source_catalog);
    const next = await createConversationJob(session, { prompt: prompt.trim(), plan, confirmation, expectedVersion });
    if (!next) throw new PublicRequestError("A newer edit is already in progress. Refresh the conversation and try again.", 409);
    return Response.json({ id: next.job.id, status: next.job.status, accessToken: next.accessToken, version: next.version, confirmation });
  } catch (error) { return jsonError(error); }
}

import { applyConversationTurn, validateConversationPlan } from "@/lib/editor-core/conversation-state";
import { analyzeEditRequestCapabilities } from "@/lib/editor-core/edit-plan";
import { ConfirmationConfigurationError, createConversationConfirmation, verifyConversationConfirmation, verifySubmittedConversationConfirmation } from "@/lib/editor-core/conversation-confirmation";
import { createConversationJob, getAuthorizedSession, getSessionHistory, paidEditingEnforced, releaseUnattachedRenderReservation, reserveRenderCapacity } from "@/lib/jobs/job-store";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { signedDownloadUrl } from "@/lib/jobs/storage";
import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { authorizePaidSession } from "@/lib/paid-editing";

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

function restoredPendingConfirmation(session, history, value) {
  if (!value) return null;
  const action = verifyConversationConfirmation({ session, token: value });
  const base = history.find((version) => version.jobId === action?.baseJobId && version.status === "completed");
  if (!base || action.expectedVersion !== session.latest_version) return null;
  return { token: value, message: action.message };
}

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const paid = await authorizePaidSession(req, id, token(req), { requireCurrentEntitlement: false });
    if (!paid && !hasFounderTestAccess(req)) throw new PublicRequestError("Editing session was not found", 404);
    const session = paid?.session || await getAuthorizedSession(id, token(req));
    if (!session) throw new PublicRequestError("Editing session was not found", 404);
    const history = await historyResponse(session);
    return Response.json({ id: session.id, latestVersion: session.latest_version, history, pendingConfirmation: restoredPendingConfirmation(session, history, req.headers.get("x-cliponaut-pending-confirmation")) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfirmationConfigurationError) return jsonError(new PublicRequestError("Confirmation is temporarily unavailable. Please try again later.", 503));
    return jsonError(error);
  }
}

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const paid = await authorizePaidSession(req, id, token(req));
    if (!paid && !hasFounderTestAccess(req)) throw new PublicRequestError("Editing session was not found", 404);
    const session = paid?.session || await getAuthorizedSession(id, token(req));
    if (!session) throw new PublicRequestError("Editing session was not found", 404);
    const { prompt, expectedVersion, baseJobId, confirmationToken } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1000) throw new PublicRequestError("Enter an editing instruction");
    if (!Number.isInteger(expectedVersion)) throw new PublicRequestError("The editing session version is invalid.");
    const history = await getSessionHistory(session.id);
    if (baseJobId !== undefined && typeof baseJobId !== "string") throw new PublicRequestError("The selected edit is invalid.", 422);
    const confirmed = confirmationToken && verifySubmittedConversationConfirmation({ session, token: confirmationToken, expectedVersion, baseJobId });
    if (confirmationToken && !confirmed) throw new PublicRequestError("That edit confirmation is no longer valid. Please review the request again.", 409);
    const executionBaseJobId = confirmed?.baseJobId || baseJobId;
    const current = [...history].reverse().find((version) => (!executionBaseJobId || version.job_id === executionBaseJobId) && version.status === "completed" && version.plan && Array.isArray(version.source_catalog));
    if (!current) throw new PublicRequestError("Wait for a successful edit before making another change.", 409);
    const effectivePrompt = confirmed?.supportedPrompt || prompt.trim();
    if (!confirmed) {
      const capability = analyzeEditRequestCapabilities(effectivePrompt, current.source_catalog);
      if (capability.kind === "partial") {
        // A partial selection may be valid for an initial AI plan but not for
        // an iterative delta. Never offer an action that this route cannot run.
        try { applyConversationTurn({ priorPlan: current.plan, prompt: capability.supportedPrompt, sourceCatalog: current.source_catalog }); }
        catch { throw new PublicRequestError("I can’t apply that supported part as a follow-up. Start a new edit to make that selection.", 422); }
        return Response.json({ pendingConfirmation: createConversationConfirmation({
          session, expectedVersion, baseJobId: baseJobId || current.job_id,
          supportedPrompt: capability.supportedPrompt, message: capability.message
        }) }, { status: 200 });
      }
      if (capability.kind === "unsupported" || capability.kind === "ambiguous") throw new PublicRequestError(capability.message, 422);
    }
    let plan;
    let confirmation;
    try {
      ({ plan, confirmation } = applyConversationTurn({ priorPlan: current.plan, prompt: effectivePrompt, sourceCatalog: current.source_catalog }));
      validateConversationPlan(plan, current.source_catalog);
    } catch (error) {
      // Conversation parsing and plan validation operate only on user input and
      // persisted plans. They are actionable request errors, not server faults.
      // Keep the response deliberately bounded so validator internals never
      // leak to a browser client.
      const message = typeof error?.message === "string" && error.message.length <= 240
        ? error.message
        : "I couldn’t safely apply that change to the current edit.";
      throw new PublicRequestError(message, 422);
    }
    const reservationId = paid ? await reserveRenderCapacity(paid.subscriberId) : null;
    if (paid && !reservationId) throw new PublicRequestError("No renders are currently available for this billing period.", 429);
    let next;
    try { next = await createConversationJob(session, { prompt: effectivePrompt, plan, confirmation, expectedVersion, subscriberId: paid?.subscriberId || null, reservationId }); }
    catch (error) { if (reservationId) await releaseUnattachedRenderReservation(reservationId, paid.subscriberId); throw error; }
    if (!next && reservationId) await releaseUnattachedRenderReservation(reservationId, paid.subscriberId);
    if (!next) throw new PublicRequestError("A newer edit is already in progress. Refresh the conversation and try again.", 409);
    return Response.json({ id: next.job.id, status: next.job.status, accessToken: next.accessToken, version: next.version, confirmation });
  } catch (error) {
    if (error instanceof ConfirmationConfigurationError) return jsonError(new PublicRequestError("Confirmation is temporarily unavailable. Please try again later.", 503));
    return jsonError(error);
  }
}

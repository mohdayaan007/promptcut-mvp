import { completeCustomerVerification, revokeCustomerSession } from "@/lib/jobs/job-store";
import { clearCustomerSession, CustomerAuthError, customerSessionToken, normalizeCustomerEmail, sessionCookie } from "@/lib/customer-auth";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
export const runtime = "nodejs";
export async function POST(req) {
  try { const { email, token } = await req.json(); const session = await completeCustomerVerification(normalizeCustomerEmail(email), token); if (!session) throw new PublicRequestError("That sign-in link is invalid or expired.", 401); return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(session), "Cache-Control": "no-store" } }); }
  catch (error) { return jsonError(error instanceof CustomerAuthError ? new PublicRequestError(error.message, error.status) : error); }
}
export async function GET(req) {
  const url = new URL(req.url); try { const session = await completeCustomerVerification(normalizeCustomerEmail(url.searchParams.get("email")), url.searchParams.get("token") || ""); if (!session) return Response.redirect(new URL("/account?error=invalid-link", url), 303); const response = Response.redirect(new URL("/account?verified=1", url), 303); response.headers.set("Set-Cookie", sessionCookie(session)); return response; } catch { return Response.redirect(new URL("/account?error=invalid-link", url), 303); }
}
export async function DELETE(req) { await revokeCustomerSession(customerSessionToken(req)); return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCustomerSession() } }); }

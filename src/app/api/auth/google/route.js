import { completeGoogleSignIn } from "@/lib/jobs/job-store";
import { clearGoogleNonce, CustomerAuthError, googleNonceToken, sessionCookie, verifyGoogleCredential } from "@/lib/customer-auth";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
export const runtime = "nodejs";
export async function POST(req) {
  try {
    const origin = req.headers.get("origin"); const host = new URL(req.url).origin;
    if (origin && origin !== host) throw new PublicRequestError("Google sign-in was rejected.", 403);
    const { credential, nonce } = await req.json(); const cookieNonce = googleNonceToken(req);
    if (!cookieNonce || nonce !== cookieNonce) throw new PublicRequestError("Google sign-in was rejected.", 403);
    const profile = await verifyGoogleCredential(credential, nonce);
    const session = await completeGoogleSignIn(profile, nonce);
    if (!session) throw new PublicRequestError("Google sign-in was rejected.", 401);
    const response = Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", sessionCookie(session)); response.headers.append("Set-Cookie", clearGoogleNonce());
    return response;
  } catch (error) { return jsonError(error instanceof CustomerAuthError ? new PublicRequestError(error.message, error.status) : error); }
}

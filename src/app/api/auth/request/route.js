import { createCustomerVerification } from "@/lib/jobs/job-store";
import { CustomerAuthError, newCustomerToken, normalizeCustomerEmail, sendVerificationEmail } from "@/lib/customer-auth";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
export const runtime = "nodejs";
export async function POST(req) {
  try {
    const { email } = await req.json(); const normalized = normalizeCustomerEmail(email); const token = newCustomerToken();
    if (await createCustomerVerification(normalized, token)) await sendVerificationEmail({ email: normalized, token });
    return Response.json({ ok: true, message: "If sign-in is available, check your email for a secure link." }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error instanceof CustomerAuthError ? new PublicRequestError(error.message, error.status) : error); }
}

import { createGoogleLoginNonce } from "@/lib/jobs/job-store";
import { newCustomerToken, nonceCookie } from "@/lib/customer-auth";
export const runtime = "nodejs";
export async function GET() { const nonce = newCustomerToken(); await createGoogleLoginNonce(nonce); return Response.json({ nonce }, { headers: { "Set-Cookie": nonceCookie(nonce), "Cache-Control": "no-store" } }); }

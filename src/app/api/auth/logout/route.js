import { customerSessionToken, clearCustomerSession } from "@/lib/customer-auth";
import { revokeCustomerSession } from "@/lib/jobs/job-store";
export const runtime = "nodejs";
export async function POST(req) { await revokeCustomerSession(customerSessionToken(req)); return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCustomerSession(), "Cache-Control": "no-store" } }); }

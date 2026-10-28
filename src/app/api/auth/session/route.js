import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerSession } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  const session = await getCustomerSession(customerSessionToken(req));
  return Response.json({ signedIn: Boolean(session), email: session?.email || null }, { headers: { "Cache-Control": "no-store" } });
}

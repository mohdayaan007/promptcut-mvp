import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerRenderUsage, getCustomerSession } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  const customer = await getCustomerSession(customerSessionToken(req));
  if (!customer) return Response.json({ error: "Sign-in is required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json(await getCustomerRenderUsage(customer.subscriber_id), { headers: { "Cache-Control": "no-store" } });
}

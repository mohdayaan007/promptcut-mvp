import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerRenderUsage, getCustomerSession, isFounderSubscriber } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  const customer = await getCustomerSession(customerSessionToken(req));
  if (!customer) return Response.json({ error: "Sign-in is required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const usage = await getCustomerRenderUsage(customer.subscriber_id);
  const founderUnlimited = await isFounderSubscriber(customer.subscriber_id);
  return Response.json({ ...usage, founderUnlimited }, { headers: { "Cache-Control": "no-store" } });
}

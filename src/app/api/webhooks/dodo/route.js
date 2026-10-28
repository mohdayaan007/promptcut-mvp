import { cliponautSubscriptionEvent, dodoTestModeConfig, DodoWebhookError, parseDodoWebhookEnvelope, verifyDodoWebhook } from "@/lib/dodo-test-mode";
import { processDodoWebhookEvent } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function POST(req) {
  const rawBody = await req.text();
  try {
    const id = verifyDodoWebhook({ headers: req.headers, rawBody });
    const event = JSON.parse(rawBody);
    const envelope = parseDodoWebhookEnvelope(event);
    const config = dodoTestModeConfig();
    const subscription = cliponautSubscriptionEvent(event, config);
    const firstSeen = await processDodoWebhookEvent(id, envelope.type, rawBody, subscription);
    if (!firstSeen) return Response.json({ received: true, duplicate: true });
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof DodoWebhookError || error instanceof SyntaxError) return Response.json({ error: "Invalid webhook" }, { status: 400 });
    console.error("dodo webhook processing failed", { name: error?.name, message: error?.message });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

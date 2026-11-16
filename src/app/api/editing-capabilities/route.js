import { analyzeEditRequestCapabilities } from "@/lib/editor-core/edit-plan";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";
import { customerMklRuntimeConfig } from "@/lib/editor-core/prepared-mkl-runtime";
import { customerSessionToken } from "@/lib/customer-auth";
import { getCustomerSession, isFounderSubscriber } from "@/lib/jobs/job-store";

export const runtime = "nodejs";

export async function GET(req) {
  try {
    // Public customers never see the private test feature before launch.
    let founderAuthorized = false;
    if (process.env.CLIPONAUT_MKL_FOUNDER_ONLY_TEST_ENABLED === "true" &&
        process.env.CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED !== "true") {
      const session = await getCustomerSession(customerSessionToken(req));
      founderAuthorized = Boolean(session && await isFounderSubscriber(session.subscriber_id));
    }
    customerMklRuntimeConfig({ founderAuthorized });
    return Response.json({ localReferenceVideoMkl: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ localReferenceVideoMkl: false }, { headers: { "Cache-Control": "private, no-store" } });
  }
}

// A deliberately media-free gate. It prevents uploads and worker planning for
// an instruction whose unsupported portion is already deterministic.
export async function POST(req) {
  try {
    const { prompt } = await req.json();
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1000) throw new PublicRequestError("Enter an editing instruction");
    return Response.json(analyzeEditRequestCapabilities(prompt));
  } catch (error) {
    return jsonError(error);
  }
}

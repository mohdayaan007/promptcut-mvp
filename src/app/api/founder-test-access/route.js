import { clearFounderTestAccess, grantFounderTestAccess, isFounderTestEnabled } from "@/lib/founder-test-access";
import { PublicRequestError, jsonError } from "@/lib/jobs/http";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    if (!isFounderTestEnabled()) throw new PublicRequestError("Founder test access is not available.", 404);
    const { accessCode } = await req.json();
    if (typeof accessCode !== "string" || accessCode.length > 512) throw new PublicRequestError("Founder test access was not granted.", 401);
    const cookie = grantFounderTestAccess(accessCode);
    if (!cookie) throw new PublicRequestError("Founder test access was not granted.", 401);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearFounderTestAccess(), "Cache-Control": "no-store" } });
}

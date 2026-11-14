import { clearFounderTestAccess, grantFounderTestAccess, isFounderTestEnabled } from "@/lib/founder-test-access";
import { PublicRequestError, jsonError } from "@/lib/jobs/http";

export const runtime = "nodejs";

function isFormRequest(req) { return (req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded"); }
function redirect(req, path, cookie = null) {
  const response = new Response(null, { status: 303, headers: { Location: new URL(path, req.url).toString() } });
  if (cookie) response.headers.set("Set-Cookie", cookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(req) {
  try {
    if (!isFounderTestEnabled()) throw new PublicRequestError("Founder test access is not available.", 404);
    const form = isFormRequest(req);
    const accessCode = form ? (await req.formData()).get("accessCode") : (await req.json()).accessCode;
    if (typeof accessCode !== "string" || accessCode.length > 512) throw new PublicRequestError("Founder test access was not granted.", 401);
    const cookie = grantFounderTestAccess(accessCode);
    if (!cookie) throw new PublicRequestError("Founder test access was not granted.", 401);
    if (form) return redirect(req, "/founder-test/reference-style", cookie);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  } catch (error) {
    if (isFormRequest(req)) return redirect(req, "/founder-test?error=access");
    return jsonError(error);
  }
}

export async function DELETE() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearFounderTestAccess(), "Cache-Control": "no-store" } });
}

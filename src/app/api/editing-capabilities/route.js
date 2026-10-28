import { analyzeEditRequestCapabilities } from "@/lib/editor-core/edit-plan";
import { jsonError, PublicRequestError } from "@/lib/jobs/http";

export const runtime = "nodejs";

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

import { hasFounderTestAccess } from "@/lib/founder-test-access";
import { prepareFounderReferenceStyleStaging } from "@/lib/editor-core/founder-reference-style-staging";
export const runtime="nodejs";
export async function GET(req) { if (!hasFounderTestAccess(req)) return Response.json({ error:"Not found" },{status:404}); try { return Response.json(await prepareFounderReferenceStyleStaging(),{headers:{"Cache-Control":"no-store"}}); } catch { return Response.json({ error:"Founder staging assets are unavailable." },{status:503}); } }

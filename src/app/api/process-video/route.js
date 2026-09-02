import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { executeEditPlan } from "@/lib/editor-core/edit-executor";
const MAX_VIDEO_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1000;

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file1 = formData.get("video1");
    const file2 = formData.get("video2");
    const promptValue = formData.get("prompt");

    if (!(file1 instanceof File)) {
      return Response.json({ error: "video1 must be an uploaded file" }, { status: 400 });
    }

    if (file2 !== null && !(file2 instanceof File)) {
      return Response.json({ error: "video2 must be an uploaded file" }, { status: 400 });
    }

    if (file1.size > MAX_VIDEO_FILE_SIZE_BYTES ||
        file2 instanceof File && file2.size > MAX_VIDEO_FILE_SIZE_BYTES) {
      return Response.json(
        { error: "Each video must be 100 MB or smaller" },
        { status: 413 }
      );
    }

    if (!file1.type.startsWith("video/") ||
        file2 instanceof File && !file2.type.startsWith("video/")) {
      return Response.json({ error: "Uploaded files must be videos" }, { status: 400 });
    }

    if (promptValue !== null && typeof promptValue !== "string") {
      return Response.json({ error: "prompt must be text" }, { status: 400 });
    }

    const prompt = promptValue || "";

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return Response.json(
        { error: "prompt must be 1000 characters or fewer" },
        { status: 400 }
      );
    }

    const tempDirectory = path.join(os.tmpdir(), `cliponaut-${Date.now()}`);
    if (!existsSync(tempDirectory)) await mkdir(tempDirectory);

    const editPlan = validateEditPlan(createEditPlan({
      prompt,
      hasSecondVideo: file2 instanceof File
    }));
    const outputPath = await executeEditPlan({ file1, file2, plan: editPlan, tempDirectory });
    const buffer = await import("fs").then((fs) => fs.promises.readFile(outputPath));

    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=cliponaut.mp4"
      }
    });

  } catch (err) {
    console.error("CLIPONAUT ERROR:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

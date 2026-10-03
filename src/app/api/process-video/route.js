import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { executeEditPlan } from "@/lib/editor-core/edit-executor";
import { createAiEditPlan, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import {
  EXPORT_QUALITIES,
  is4kCapableMedia,
  isSupportedExportQuality,
  MAX_REQUEST_VIDEO_BYTES,
  MAX_VIDEO_COUNT,
  MAX_VIDEO_FILE_SIZE_BYTES
} from "@/lib/media/media-config";
import { MediaProbeError, probeVideoFile } from "@/lib/media/media-probe";

const MAX_PROMPT_LENGTH = 1000;

export const runtime = "nodejs";

class RequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function submittedVideos(formData) {
  if (formData.has("videos")) return formData.getAll("videos");
  return [formData.get("video1"), formData.get("video2")].filter((file) => file !== null);
}

function validateVideos(videos) {
  if (!videos.length) throw new RequestValidationError("Upload at least one video");
  if (videos.length > MAX_VIDEO_COUNT) {
    throw new RequestValidationError(`Upload up to ${MAX_VIDEO_COUNT} videos at a time`);
  }
  if (videos.some((file) => !(file instanceof File))) {
    throw new RequestValidationError("Each upload must be a video file");
  }
  if (videos.some((file) => !file.size || !file.type.startsWith("video/"))) {
    throw new RequestValidationError("Uploaded files must be videos");
  }
  if (videos.some((file) => file.size > MAX_VIDEO_FILE_SIZE_BYTES)) {
    throw new RequestValidationError("Each video must be 250 MB or smaller", 413);
  }
  const totalSize = videos.reduce((total, file) => total + file.size, 0);
  if (totalSize > MAX_REQUEST_VIDEO_BYTES) {
    throw new RequestValidationError("The combined upload must be 500 MB or smaller", 413);
  }
}

function validatePrompt(value) {
  if (value !== null && typeof value !== "string") throw new RequestValidationError("prompt must be text");
  const prompt = value || "";
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new RequestValidationError("prompt must be 1000 characters or fewer");
  }
  return prompt;
}

function validateExportQuality(value, media) {
  const exportQuality = value || "standard";
  if (typeof exportQuality !== "string" || !isSupportedExportQuality(exportQuality)) {
    throw new RequestValidationError(`exportQuality must be one of: ${EXPORT_QUALITIES.join(", ")}`);
  }
  if (exportQuality === "4k" && !media.every(is4kCapableMedia)) {
    throw new RequestValidationError("4K export requires every uploaded video to be 4K-capable");
  }
  return exportQuality;
}

export async function POST(req) {
  let tempDirectory;
  try {
    const formData = await req.formData();
    const videos = submittedVideos(formData);
    validateVideos(videos);
    const prompt = validatePrompt(formData.get("prompt"));

    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-"));
    const inputPaths = [];
    for (const [index, file] of videos.entries()) {
      const inputPath = path.join(tempDirectory, `source-${index}.mp4`);
      await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));
      inputPaths.push(inputPath);
    }
    const media = [];
    for (const inputPath of inputPaths) media.push(await probeVideoFile(inputPath));
    const exportQuality = validateExportQuality(formData.get("exportQuality"), media);
    const sourceCatalog = createSourceCatalog(
      videos.map((file, index) => ({ index, name: file.name, type: file.type, size: file.size })),
      media
    );

    const { plan } = await createAiEditPlan({
      inputPath: inputPaths[0],
      inputMimeType: videos[0].type,
      sourceInputs: videos.map((file, index) => ({ inputPath: inputPaths[index], inputMimeType: file.type, source: sourceCatalog[index] })),
      prompt,
      hasMultipleVideos: videos.length > 1,
      sourceCatalog
    });
    let editPlan;
    try {
      editPlan = validateEditPlan(plan, { sourceCatalog });
    } catch (error) {
      console.error("Edit plan validation failed:", error.message);
      return Response.json({ error: "This edit is not currently supported" }, { status: 422 });
    }

    const outputPath = await executeEditPlan({ inputPaths, media, plan: editPlan, sourceCatalog, tempDirectory, exportQuality });
    const buffer = await readFile(outputPath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=cliponaut.mp4"
      }
    });
  } catch (error) {
    if (error instanceof RequestValidationError || error instanceof MediaProbeError) {
      return Response.json({ error: error.message }, { status: error.status || 400 });
    }
    if (error instanceof UnsupportedEditRequestError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error("CLIPONAUT ERROR:", error);
    return Response.json({ error: "Unable to process this video. Please try again." }, { status: 500 });
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

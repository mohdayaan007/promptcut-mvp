import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { createEditPlan } from "@/lib/editor-core/edit-plan";
import { createEditPlanJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { buildAiEditorPrompt } from "@/lib/editor-core/ai-editor/prompt";

const DEFAULT_MODEL = "gemini-3.6-flash";
const FILE_PROCESSING_TIMEOUT_MS = 60_000;
const FILE_PROCESSING_POLL_MS = 2_000;

export class UnsupportedEditRequestError extends Error {}

function addAutomaticMerge(plan, hasMultipleVideos) {
  if (!hasMultipleVideos || plan.version === "2") return plan;
  return { ...plan, operations: [{ type: "merge" }, ...plan.operations] };
}

async function waitForActiveFile(ai, uploadedFile) {
  const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
  let file = uploadedFile;

  while (file.state === "PROCESSING") {
    if (Date.now() >= deadline) throw new Error("Gemini video processing timed out");
    await new Promise((resolve) => setTimeout(resolve, FILE_PROCESSING_POLL_MS));
    file = await ai.files.get({ name: file.name });
  }

  if (file.state !== "ACTIVE" || !file.uri || !file.mimeType) {
    throw new Error("Gemini could not process the uploaded video");
  }

  return file;
}

async function createGeminiPlan({ inputPath, inputMimeType, prompt, hasMultipleVideos, sourceCatalog }) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let uploadedFile;
  try {
    uploadedFile = await ai.files.upload({
      file: inputPath,
      config: { mimeType: inputMimeType || "video/mp4" }
    });
    const activeFile = await waitForActiveFile(ai, uploadedFile);
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents: [
        createPartFromUri(activeFile.uri, activeFile.mimeType),
        buildAiEditorPrompt({ prompt, hasMultipleVideos, sourceCatalog })
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) })
      }
    });

    if (!response.text) throw new Error("Gemini returned no edit plan");
    const plan = JSON.parse(response.text);
    if (!Array.isArray(plan.operations)) throw new Error("Gemini returned a malformed edit plan");
    if (!plan.operations.length) throw new UnsupportedEditRequestError("This edit is not supported yet");
    return addAutomaticMerge(plan, hasMultipleVideos);
  } finally {
    if (uploadedFile?.name) {
      await ai.files.delete({ name: uploadedFile.name }).catch((error) => {
        console.warn("Unable to delete Gemini upload:", error.message);
      });
    }
  }
}

export async function createAiEditPlan({ inputPath, inputMimeType, prompt, hasMultipleVideos = false, sourceCatalog = [] }) {
  if (!process.env.GEMINI_API_KEY || !prompt.trim()) {
    return {
      plan: createEditPlan({ prompt, hasMultipleVideos, sourceCatalog }),
      source: "deterministic"
    };
  }

  try {
    return {
      plan: await createGeminiPlan({ inputPath, inputMimeType, prompt, hasMultipleVideos, sourceCatalog }),
      source: "gemini"
    };
  } catch (error) {
    if (error instanceof UnsupportedEditRequestError) throw error;
    console.error("Gemini planning failed; using deterministic fallback:", error.message);
    return {
      plan: createEditPlan({ prompt, hasMultipleVideos, sourceCatalog }),
      source: "deterministic"
    };
  }
}

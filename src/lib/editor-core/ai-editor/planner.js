import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { createEditPlan, extractSemanticSourceReferences, requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { createEditPlanJsonSchema, createSemanticSourceClassificationJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { buildAiEditorPrompt, buildSemanticSourceClassificationPrompt } from "@/lib/editor-core/ai-editor/prompt";

const DEFAULT_MODEL = "gemini-3.6-flash";
const FILE_PROCESSING_TIMEOUT_MS = 60_000;
const FILE_PROCESSING_POLL_MS = 2_000;
const MAX_PLANNING_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

export class UnsupportedEditRequestError extends Error {}
export class GeminiSourceUploadError extends UnsupportedEditRequestError {}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safePlanningErrorMessage(error) {
  if (typeof error?.message !== "string") return null;

  return error.message
    .replace(/(?:https?|s3|gs):\/\/[^\s'"`]+/gi, "[redacted-url]")
    .replace(/\bfiles\/[A-Za-z0-9_-]+/gi, "[redacted-gemini-file]")
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|credential|secret|signature)=?[^\s,;]+/gi, "$1=[redacted]");
}

function sourceLabel({ sourceId = "source-1", ordinal = 1, filename = "unknown", duration = "unknown", width = "unknown", height = "unknown" } = {}) {
  return [
    `SOURCE ${sourceId}`,
    `ordinal: ${ordinal}`,
    `filename: ${filename}`,
    `duration: ${duration}`,
    `dimensions: ${width}x${height}`
  ].join("\n");
}

export function buildMultiSourceContents(activeSources, prompt) {
  return [
    ...activeSources.flatMap(({ source, file }) => [sourceLabel(source), createPartFromUri(file.uri, file.mimeType)]),
    prompt
  ];
}

export function buildSingleSourceContents({ source, file }, prompt) {
  return [sourceLabel(source), createPartFromUri(file.uri, file.mimeType), prompt];
}

export function isTransientPlanningError(error) {
  const status = Number(error?.status || error?.statusCode || error?.code || error?.$metadata?.httpStatusCode);
  return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

function isGeminiFileLimitError(error) {
  const status = Number(error?.status || error?.statusCode || error?.code || error?.$metadata?.httpStatusCode);
  return status === 413 || /(?:file|upload).*(?:size|limit|large)|(?:size|limit|large).*(?:file|upload)/i.test(error?.message || "");
}

async function generateWithRetries(ai, request, { sleepFn = sleep, random = Math.random } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_PLANNING_RETRIES; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      lastError = error;
      if (!isTransientPlanningError(error) || attempt === MAX_PLANNING_RETRIES) throw error;
      const jitter = Math.floor(random() * RETRY_BASE_DELAY_MS);
      await sleepFn(RETRY_BASE_DELAY_MS * (2 ** attempt) + jitter);
    }
  }
  throw lastError;
}

function addAutomaticMerge(plan, hasMultipleVideos) {
  if (!hasMultipleVideos || plan.version === "2") return plan;
  return { ...plan, operations: [{ type: "merge" }, ...plan.operations] };
}

function collapseGlobalSourceColorGrades(plan) {
  if (plan.version !== "2") return plan;
  const sequence = plan.operations.find((operation) => operation.type === "sequence");
  const sourceIds = new Set(sequence?.clips?.map((clip) => clip.sourceId));
  const sourceGrades = plan.operations.filter((operation) => operation.type === "color_grade" && operation.sourceId);

  if (sourceIds.size < 2 || sourceGrades.length !== sourceIds.size || new Set(sourceGrades.map((operation) => operation.style)).size !== 1) {
    return plan;
  }
  if (new Set(sourceGrades.map((operation) => operation.sourceId)).size !== sourceIds.size || ![...sourceIds].every((sourceId) => sourceGrades.some((operation) => operation.sourceId === sourceId))) {
    return plan;
  }

  let addedGlobalGrade = false;
  return {
    ...plan,
    operations: plan.operations.flatMap((operation) => {
      if (!sourceGrades.includes(operation)) return [operation];
      if (addedGlobalGrade) return [];
      addedGlobalGrade = true;
      return [{ type: "color_grade", style: sourceGrades[0].style }];
    })
  };
}

function semanticSelectionError() {
  return new UnsupportedEditRequestError("This edit needs Gemini video understanding");
}

export function resolveSemanticSourceClassifications(classifications, semanticReferences, sourceCatalog) {
  if (!Array.isArray(classifications) || classifications.length !== sourceCatalog.length) {
    throw semanticSelectionError();
  }

  const expectedReferenceIds = new Set(semanticReferences.map((reference) => reference.referenceId));
  const sourceIds = new Set(sourceCatalog.map((source) => source.sourceId));
  const classifiedSources = new Set();
  const candidatesByReference = new Map(semanticReferences.map((reference) => [reference.referenceId, []]));

  for (const classification of classifications) {
    const { expectedSourceId, response } = classification || {};
    if (!sourceIds.has(expectedSourceId) || classifiedSources.has(expectedSourceId) || response?.sourceId !== expectedSourceId || !Array.isArray(response.matches) || response.matches.length !== semanticReferences.length) {
      throw semanticSelectionError();
    }

    const matchesByReference = new Set();
    for (const match of response.matches) {
      if (!expectedReferenceIds.has(match?.referenceId) || matchesByReference.has(match.referenceId) || typeof match.plausibleMatch !== "boolean") {
        throw semanticSelectionError();
      }
      matchesByReference.add(match.referenceId);
      if (match.plausibleMatch) candidatesByReference.get(match.referenceId).push(expectedSourceId);
    }
    if (matchesByReference.size !== expectedReferenceIds.size) throw semanticSelectionError();
    classifiedSources.add(expectedSourceId);
  }

  if (classifiedSources.size !== sourceIds.size) throw semanticSelectionError();
  return semanticReferences.map((reference) => {
    const candidates = candidatesByReference.get(reference.referenceId);
    if (candidates.length !== 1) throw semanticSelectionError();
    return { ...reference, sourceId: candidates[0] };
  });
}

function validateResolvedSemanticSourcesInPlan(plan, resolvedSemanticSources) {
  if (!resolvedSemanticSources.length) return;
  const sequence = plan.version === "2" && plan.operations.find((operation) => operation.type === "sequence");
  if (!sequence || !Array.isArray(sequence.clips)) throw semanticSelectionError();

  let clipIndex = 0;
  for (const { sourceId } of resolvedSemanticSources) {
    clipIndex = sequence.clips.findIndex((clip, index) => index >= clipIndex && clip.sourceId === sourceId);
    if (clipIndex === -1) throw semanticSelectionError();
    clipIndex += 1;
  }
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

async function createGeminiPlan({ sourceInputs, prompt, hasMultipleVideos, sourceCatalog, aiClient, retryOptions }) {
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const uploadedFiles = [];
  const semanticReferences = extractSemanticSourceReferences(prompt, sourceCatalog);
  const requiresVisualUnderstanding = semanticReferences.length > 0;
  try {
    const activeSources = [];
    for (const input of sourceInputs) {
      try {
        const uploadedFile = await ai.files.upload({
          file: input.inputPath,
          config: { mimeType: input.inputMimeType || "video/mp4" }
        });
        uploadedFiles.push(uploadedFile);
        const activeFile = await waitForActiveFile(ai, uploadedFile);
        activeSources.push({ source: input.source, file: activeFile });
      } catch (error) {
        if (isGeminiFileLimitError(error)) {
          throw new GeminiSourceUploadError("An uploaded video is too large for Gemini analysis");
        }
        throw error;
      }
    }
    let resolvedSemanticSources = [];
    if (semanticReferences.length) {
      try {
        const classifications = [];
        for (const activeSource of activeSources) {
          const classificationResponse = await generateWithRetries(ai, {
            model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
            contents: buildSingleSourceContents(activeSource, buildSemanticSourceClassificationPrompt({
              source: activeSource.source,
              semanticReferences
            })),
            config: {
              responseMimeType: "application/json",
              responseJsonSchema: createSemanticSourceClassificationJsonSchema({
                sourceId: activeSource.source.sourceId,
                referenceIds: semanticReferences.map((reference) => reference.referenceId)
              })
            }
          }, retryOptions);
          if (!classificationResponse.text) throw semanticSelectionError();
          classifications.push({
            expectedSourceId: activeSource.source.sourceId,
            response: JSON.parse(classificationResponse.text)
          });
        }
        resolvedSemanticSources = resolveSemanticSourceClassifications(classifications, semanticReferences, sourceCatalog);
      } catch (error) {
        if (error instanceof UnsupportedEditRequestError) throw error;
        throw semanticSelectionError();
      }
    }

    const response = await generateWithRetries(ai, {
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents: buildMultiSourceContents(activeSources, buildAiEditorPrompt({ prompt, hasMultipleVideos, sourceCatalog, resolvedSemanticSources })),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) })
      }
    }, retryOptions);

    if (!response.text) throw new Error("Gemini returned no edit plan");
    const plan = JSON.parse(response.text);
    if (!Array.isArray(plan.operations)) throw new Error("Gemini returned a malformed edit plan");
    if (!plan.operations.length) throw new UnsupportedEditRequestError("This edit is not supported yet");
    if (requiresVisualUnderstanding && plan.version !== "2") {
      throw new UnsupportedEditRequestError("This source description could not be identified confidently");
    }
    validateResolvedSemanticSourcesInPlan(plan, resolvedSemanticSources);
    return addAutomaticMerge(collapseGlobalSourceColorGrades(plan), hasMultipleVideos);
  } finally {
    await Promise.all(uploadedFiles.filter((file) => file?.name).map((file) =>
      ai.files.delete({ name: file.name }).catch((error) => {
        console.warn("Unable to delete Gemini upload:", error.message);
      })
    ));
  }
}

export async function createAiEditPlan({ inputPath, inputMimeType, sourceInputs, prompt, hasMultipleVideos = false, sourceCatalog = [], aiClient, retryOptions }) {
  const planningSources = sourceInputs?.length
    ? sourceInputs
    : inputPath ? [{ inputPath, inputMimeType, source: sourceCatalog[0] }] : [];
  const requiresVisualUnderstanding = requiresVisualSourceUnderstanding(prompt, sourceCatalog);
  if (!process.env.GEMINI_API_KEY || !prompt.trim()) {
    if (requiresVisualUnderstanding) throw new UnsupportedEditRequestError("This edit needs Gemini video understanding");
    return {
      plan: createEditPlan({ prompt, hasMultipleVideos, sourceCatalog }),
      source: "deterministic"
    };
  }

  try {
    return {
      plan: await createGeminiPlan({ sourceInputs: planningSources, prompt, hasMultipleVideos, sourceCatalog, aiClient, retryOptions }),
      source: "gemini"
    };
  } catch (error) {
    if (error instanceof UnsupportedEditRequestError) throw error;
    if (requiresVisualUnderstanding) {
      console.error("Gemini visual planning failed:", {
        name: error?.name || null,
        message: safePlanningErrorMessage(error),
        status: error?.status ?? error?.statusCode ?? error?.code ?? error?.$metadata?.httpStatusCode ?? null,
        apiStatus: error?.statusText ?? null
      });
      throw new UnsupportedEditRequestError("This edit needs Gemini video understanding");
    }
    console.error("Gemini planning failed; using deterministic fallback:", error.message);
    return {
      plan: createEditPlan({ prompt, hasMultipleVideos, sourceCatalog }),
      source: "deterministic"
    };
  }
}

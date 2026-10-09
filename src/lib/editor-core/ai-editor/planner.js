import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { createEditPlan, extractMomentCompositionRequests, extractSemanticSourceReferences, extractSpokenMomentRequest, extractVisualMomentRequest, requiresMomentCompositionUnderstanding, requiresSpokenMomentUnderstanding, requiresVisualMomentUnderstanding, requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { createEditPlanJsonSchema, createSemanticSourceClassificationJsonSchema, createSemanticTranscriptMatchJsonSchema, createVisualMomentLocalizationJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { buildAiEditorPrompt, buildSemanticSourceClassificationPrompt, buildSemanticTranscriptMatchPrompt, buildVisualMomentLocalizationPrompt } from "@/lib/editor-core/ai-editor/prompt";
import { findPhraseOccurrences, pairPhraseOccurrences } from "@/lib/editor-core/spoken-transcript";
import { transcribeSource } from "@/lib/editor-core/spoken-transcription";
import { EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

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

function semanticSelectionError(reason, details = {}) {
  if (reason) {
    console.error("Semantic source resolution rejected:", { reason, ...details });
  }
  return new UnsupportedEditRequestError("This edit needs Gemini video understanding");
}

function visualMomentError(reason, details = {}) {
  if (reason) console.error("Visual moment localization rejected:", { reason, ...details });
  return new UnsupportedEditRequestError("This edit needs Gemini video understanding");
}

function spokenMomentError(reason, details = {}) {
  if (reason) console.error("Spoken moment localization rejected:", { reason, ...details });
  return new UnsupportedEditRequestError("This edit needs Gemini video understanding");
}

function safeClassificationMatches(response, semanticReferences) {
  if (!Array.isArray(response?.matches)) return [];
  const referenceIds = new Set(semanticReferences.map((reference) => reference.referenceId));
  return response.matches.map((match) => ({
    referenceId: referenceIds.has(match?.referenceId) ? match.referenceId : null,
    plausibleMatch: typeof match?.plausibleMatch === "boolean" ? match.plausibleMatch : null
  }));
}

function logClassificationResponse(sourceId, response, semanticReferences) {
  console.info("Gemini semantic source classification:", {
    sourceId,
    matches: safeClassificationMatches(response, semanticReferences)
  });
}

function logClassificationRequestFailure(sourceId, error) {
  const transient = isTransientPlanningError(error);
  console.error("Gemini semantic source classification request failed:", {
    reason: transient ? "SEMANTIC_CLASSIFICATION_RETRIES_EXHAUSTED" : "SEMANTIC_CLASSIFICATION_REQUEST_FAILED",
    sourceId,
    name: error?.name || null,
    message: safePlanningErrorMessage(error),
    status: error?.status ?? error?.statusCode ?? error?.code ?? error?.$metadata?.httpStatusCode ?? null,
    apiStatus: error?.statusText ?? null,
    transient
  });
}

function logMomentLocalizationRequestFailure(sourceId, error) {
  const transient = isTransientPlanningError(error);
  console.error("Gemini visual moment localization request failed:", {
    reason: transient ? "MOMENT_LOCALIZATION_RETRIES_EXHAUSTED" : "MOMENT_LOCALIZATION_REQUEST_FAILED",
    sourceId,
    name: error?.name || null,
    message: safePlanningErrorMessage(error),
    status: error?.status ?? error?.statusCode ?? error?.code ?? error?.$metadata?.httpStatusCode ?? null,
    apiStatus: error?.statusText ?? null,
    transient
  });
}

function logSemanticFinalPlanMismatch(plan) {
  console.error("Semantic final plan rejected:", {
    reason: "SEMANTIC_FINAL_PLAN_MISMATCH",
    planVersion: typeof plan?.version === "string" ? plan.version : null,
    operationCount: Array.isArray(plan?.operations) ? plan.operations.length : null
  });
}

export function resolveSemanticSourceClassifications(classifications, semanticReferences, sourceCatalog) {
  if (!Array.isArray(classifications) || classifications.length !== sourceCatalog.length) {
    throw semanticSelectionError("SEMANTIC_MISSING_SOURCE_CLASSIFICATION", {
      expectedSourceCount: sourceCatalog.length,
      receivedClassificationCount: Array.isArray(classifications) ? classifications.length : null
    });
  }

  const expectedReferenceIds = new Set(semanticReferences.map((reference) => reference.referenceId));
  const sourceIds = new Set(sourceCatalog.map((source) => source.sourceId));
  const classifiedSources = new Set();
  const candidatesByReference = new Map(semanticReferences.map((reference) => [reference.referenceId, []]));

  for (const classification of classifications) {
    const { expectedSourceId, response } = classification || {};
    if (!sourceIds.has(expectedSourceId) || response?.sourceId !== expectedSourceId) {
      throw semanticSelectionError("SEMANTIC_WRONG_SOURCE_ID", {
        expectedSourceId: sourceIds.has(expectedSourceId) ? expectedSourceId : null,
        responseSourceId: sourceIds.has(response?.sourceId) ? response.sourceId : null
      });
    }
    if (classifiedSources.has(expectedSourceId)) {
      throw semanticSelectionError("SEMANTIC_DUPLICATE_SOURCE_CLASSIFICATION", { sourceId: expectedSourceId });
    }
    if (!Array.isArray(response.matches)) {
      throw semanticSelectionError("SEMANTIC_MALFORMED_RESPONSE", { sourceId: expectedSourceId });
    }
    if (response.matches.length !== semanticReferences.length) {
      throw semanticSelectionError("SEMANTIC_MISSING_REFERENCE", {
        sourceId: expectedSourceId,
        expectedReferenceCount: semanticReferences.length,
        receivedReferenceCount: response.matches.length
      });
    }

    const matchesByReference = new Set();
    for (const match of response.matches) {
      if (!expectedReferenceIds.has(match?.referenceId) || matchesByReference.has(match.referenceId) || typeof match.plausibleMatch !== "boolean") {
        const reason = !expectedReferenceIds.has(match?.referenceId)
          ? "SEMANTIC_UNKNOWN_REFERENCE"
          : matchesByReference.has(match.referenceId)
            ? "SEMANTIC_DUPLICATE_REFERENCE"
            : "SEMANTIC_INVALID_BOOLEAN";
        throw semanticSelectionError(reason, {
          sourceId: expectedSourceId,
          referenceId: expectedReferenceIds.has(match?.referenceId) ? match.referenceId : null
        });
      }
      matchesByReference.add(match.referenceId);
      if (match.plausibleMatch) candidatesByReference.get(match.referenceId).push(expectedSourceId);
    }
    if (matchesByReference.size !== expectedReferenceIds.size) {
      throw semanticSelectionError("SEMANTIC_MISSING_REFERENCE", {
        sourceId: expectedSourceId,
        expectedReferenceCount: expectedReferenceIds.size,
        receivedReferenceCount: matchesByReference.size
      });
    }
    classifiedSources.add(expectedSourceId);
  }

  if (classifiedSources.size !== sourceIds.size) {
    throw semanticSelectionError("SEMANTIC_MISSING_SOURCE_CLASSIFICATION", {
      expectedSourceCount: sourceIds.size,
      receivedClassificationCount: classifiedSources.size
    });
  }
  console.info("Semantic source candidate sets:", {
    candidatesByReference: Object.fromEntries(candidatesByReference)
  });
  return semanticReferences.map((reference) => {
    const candidates = candidatesByReference.get(reference.referenceId);
    if (candidates.length !== 1) {
      throw semanticSelectionError(candidates.length === 0 ? "SEMANTIC_NO_CANDIDATE" : "SEMANTIC_AMBIGUOUS", {
        referenceId: reference.referenceId,
        candidateSourceIds: candidates
      });
    }
    return { ...reference, sourceId: candidates[0] };
  });
}

function localizationSourcesForMoment(momentRequest, sourceCatalog, resolvedSemanticSources) {
  const scope = momentRequest.sourceScope;
  if (scope.type === "explicit" || scope.type === "single") {
    const source = sourceCatalog.find((entry) => entry.sourceId === scope.sourceId);
    if (!source) throw visualMomentError("MOMENT_UNKNOWN_SOURCE", { sourceId: scope.sourceId || null });
    return [source];
  }
  if (scope.type === "semantic") {
    const resolved = resolvedSemanticSources.find((entry) => entry.referenceId === scope.referenceId);
    const source = sourceCatalog.find((entry) => entry.sourceId === resolved?.sourceId);
    if (!source) throw visualMomentError("MOMENT_MISSING_SOURCE_RESOLUTION", { referenceId: scope.referenceId });
    return [source];
  }
  return sourceCatalog;
}

function validMomentCandidate(candidate, source) {
  return candidate && typeof candidate.start === "number" && Number.isFinite(candidate.start) &&
    typeof candidate.end === "number" && Number.isFinite(candidate.end) &&
    candidate.start >= 0 && candidate.end > candidate.start && candidate.end <= source.duration;
}

function deriveMomentRange(candidate, momentRequest, source) {
  const range = momentRequest.mode === "START_BOUNDARY"
    ? { start: candidate.start, end: source.duration }
    : momentRequest.mode === "END_BOUNDARY"
      ? { start: 0, end: candidate.end }
      : { start: candidate.start, end: candidate.end };
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end > source.duration) {
    throw visualMomentError("MOMENT_INVALID_DERIVED_RANGE", { sourceId: source.sourceId });
  }
  return range;
}

export function resolveVisualMomentLocalizations(localizations, momentRequest, sourceCatalog, expectedSourceIds) {
  if (!Array.isArray(localizations) || localizations.length !== expectedSourceIds.length) {
    throw visualMomentError("MOMENT_MISSING_SOURCE_LOCALIZATION", {
      expectedSourceCount: expectedSourceIds.length,
      receivedLocalizationCount: Array.isArray(localizations) ? localizations.length : null
    });
  }

  const sourceById = new Map(sourceCatalog.map((source) => [source.sourceId, source]));
  const expected = new Set(expectedSourceIds);
  const localized = new Set();
  const candidates = [];
  for (const localization of localizations) {
    const { expectedSourceId, response } = localization || {};
    if (!expected.has(expectedSourceId) || !sourceById.has(expectedSourceId) || response?.sourceId !== expectedSourceId) {
      throw visualMomentError("MOMENT_SOURCE_MISMATCH", {
        expectedSourceId: expected.has(expectedSourceId) ? expectedSourceId : null,
        responseSourceId: expected.has(response?.sourceId) ? response.sourceId : null
      });
    }
    if (localized.has(expectedSourceId)) throw visualMomentError("MOMENT_DUPLICATE_SOURCE_LOCALIZATION", { sourceId: expectedSourceId });
    if (!Array.isArray(response.moments)) throw visualMomentError("MOMENT_MALFORMED_RESPONSE", { sourceId: expectedSourceId });
    if (response.moments.length !== 1) {
      const returnedMomentIds = response.moments.map((moment) => moment?.momentId).filter(Boolean);
      const requestedCount = returnedMomentIds.filter((momentId) => momentId === momentRequest.momentId).length;
      throw visualMomentError(
        requestedCount > 1 ? "MOMENT_DUPLICATE_MOMENT" : returnedMomentIds.some((momentId) => momentId !== momentRequest.momentId) ? "MOMENT_UNKNOWN_MOMENT" : "MOMENT_MISSING_MOMENT",
        { sourceId: expectedSourceId, receivedMomentCount: response.moments.length }
      );
    }

    const [moment] = response.moments;
    if (moment?.momentId !== momentRequest.momentId) {
      throw visualMomentError(moment?.momentId ? "MOMENT_UNKNOWN_MOMENT" : "MOMENT_MISSING_MOMENT", { sourceId: expectedSourceId });
    }
    if (!Array.isArray(moment.candidates)) throw visualMomentError("MOMENT_MISSING_CANDIDATES", { sourceId: expectedSourceId });

    const source = sourceById.get(expectedSourceId);
    for (const candidate of moment.candidates) {
      if (!validMomentCandidate(candidate, source)) throw visualMomentError("MOMENT_INVALID_TIMESTAMP_RANGE", { sourceId: expectedSourceId });
      candidates.push({ sourceId: expectedSourceId, ...deriveMomentRange(candidate, momentRequest, source) });
    }
    localized.add(expectedSourceId);
  }

  if (localized.size !== expected.size) {
    throw visualMomentError("MOMENT_MISSING_SOURCE_LOCALIZATION", {
      expectedSourceCount: expected.size,
      receivedLocalizationCount: localized.size
    });
  }
  console.info("Visual moment candidate set:", {
    momentId: momentRequest.momentId,
    sourceIds: candidates.map((candidate) => candidate.sourceId),
    candidateCount: candidates.length
  });
  if (!candidates.length) throw visualMomentError("MOMENT_NO_CANDIDATE", { momentId: momentRequest.momentId });
  if (candidates.length > 1) throw visualMomentError("MOMENT_AMBIGUOUS", { momentId: momentRequest.momentId, candidateCount: candidates.length });
  return candidates[0];
}

function applyAuthoritativeMomentSequence(plan, localizedMoments, { reject = visualMomentError, mismatchReason = "MOMENT_FINAL_PLAN_SOURCE_MISMATCH", rejectSourceScopedOperations = false } = {}) {
  const moments = Array.isArray(localizedMoments) ? localizedMoments : [localizedMoments];
  const authoritativeSequence = {
    type: "sequence",
    clips: moments.map(({ sourceId, start, end }) => ({ sourceId, start, end }))
  };
  const nonSequenceOperations = plan.operations.filter((operation) => operation.type !== "sequence");
  const authoritativeSourceIds = new Set(authoritativeSequence.clips.map((clip) => clip.sourceId));
  if (nonSequenceOperations.some((operation) => operation.sourceId && (rejectSourceScopedOperations || !authoritativeSourceIds.has(operation.sourceId)))) {
    throw reject(mismatchReason, { sourceIds: [...authoritativeSourceIds] });
  }
  return { ...plan, version: "2", operations: [authoritativeSequence, ...nonSequenceOperations] };
}

function speechSourcesForMoment(momentRequest, sourceCatalog, resolvedSemanticSources) {
  const scope = momentRequest.sourceScope;
  if (scope.type === "unscoped") return sourceCatalog;
  return localizationSourcesForMoment(momentRequest, sourceCatalog, resolvedSemanticSources);
}

function exactSpokenCandidates(transcript, momentRequest, source) {
  const starts = momentRequest.startPhrase ? findPhraseOccurrences(transcript, momentRequest.startPhrase, momentRequest.mode) : [];
  const ends = momentRequest.endPhrase ? findPhraseOccurrences(transcript, momentRequest.endPhrase, momentRequest.mode) : [];
  const candidates = momentRequest.mode === "START_END_BOUNDARY"
    ? pairPhraseOccurrences(starts, ends).map(({ start, end }) => ({ start, end }))
    : momentRequest.mode === "START_BOUNDARY"
      ? starts.map((match) => ({ start: match.start, end: source.duration }))
      : momentRequest.mode === "END_BOUNDARY"
        ? ends.map((match) => ({ start: 0, end: match.end }))
        : starts.map((match) => ({ start: match.start, end: match.end }));
  return candidates.map((candidate) => ({ sourceId: source.sourceId, ...candidate }));
}

function validateSemanticTranscriptCandidates(response, momentRequest, transcript, source) {
  if (response?.sourceId !== source.sourceId) throw spokenMomentError("SPEECH_SOURCE_MISMATCH", { sourceId: source.sourceId });
  if (response?.momentId !== momentRequest.momentId || !Array.isArray(response?.candidates)) {
    throw spokenMomentError("SPEECH_MALFORMED_SEMANTIC_RESPONSE", { sourceId: source.sourceId, momentId: momentRequest.momentId });
  }
  const segments = transcript.segments || [];
  const indexById = new Map(segments.map((segment, index) => [segment.segmentId, index]));
  const candidates = [];
  const seen = new Set();
  for (const candidate of response.candidates) {
    if (!candidate || Object.keys(candidate).some((key) => key !== "startSegmentId" && key !== "endSegmentId")) {
      throw spokenMomentError("SPEECH_MALFORMED_SEMANTIC_RESPONSE", { sourceId: source.sourceId });
    }
    const startSegmentId = candidate?.startSegmentId;
    const endSegmentId = candidate?.endSegmentId;
    if (!startSegmentId || !endSegmentId) throw spokenMomentError("SPEECH_MISSING_SEGMENT", { sourceId: source.sourceId });
    const startIndex = indexById.get(startSegmentId);
    const endIndex = indexById.get(endSegmentId);
    if (startIndex === undefined || endIndex === undefined) throw spokenMomentError("SPEECH_UNKNOWN_SEGMENT", { sourceId: source.sourceId });
    if (startIndex > endIndex) throw spokenMomentError("SPEECH_INVALID_SEGMENT_RANGE", { sourceId: source.sourceId });
    const startSegment = segments[startIndex];
    const endSegment = segments[endIndex];
    const range = momentRequest.mode === "START_BOUNDARY"
      ? { start: startSegment.start, end: source.duration }
      : momentRequest.mode === "END_BOUNDARY"
        ? { start: 0, end: endSegment.end }
        : { start: startSegment.start, end: endSegment.end };
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end > source.duration) {
      throw spokenMomentError("SPEECH_INVALID_SEGMENT_RANGE", { sourceId: source.sourceId });
    }
    const key = `${startSegmentId}:${endSegmentId}`;
    if (!seen.has(key)) { seen.add(key); candidates.push({ sourceId: source.sourceId, ...range }); }
  }
  return candidates;
}

function resolveSpokenCandidates(candidates, momentRequest) {
  console.info("Spoken moment candidate set:", { momentId: momentRequest.momentId, sourceIds: candidates.map((candidate) => candidate.sourceId), candidateCount: candidates.length });
  if (!candidates.length) throw spokenMomentError("SPEECH_NO_CANDIDATE", { momentId: momentRequest.momentId });
  if (candidates.length > 1) throw spokenMomentError("SPEECH_AMBIGUOUS", { momentId: momentRequest.momentId, candidateCount: candidates.length });
  return candidates[0];
}

async function localizeSpokenMoment({ momentRequest, sourceCatalog, resolvedSemanticSources, sourceInputs, ai, retryOptions, scratchDirectory, executionController, transcriptionOptions, transcripts }) {
  if (!scratchDirectory) throw spokenMomentError("SPEECH_MISSING_SCRATCH_DIRECTORY", { momentId: momentRequest.momentId });
  const targetSources = speechSourcesForMoment(momentRequest, sourceCatalog, resolvedSemanticSources);
  const candidates = [];
  for (const source of targetSources) {
    if (!source.hasAudio) continue;
    const input = sourceInputs.find((entry) => entry.source?.sourceId === source.sourceId);
    if (!input) throw spokenMomentError("SPEECH_SOURCE_MISMATCH", { sourceId: source.sourceId, momentId: momentRequest.momentId });
    let transcript = transcripts.get(source.sourceId);
    if (!transcript) {
      transcript = await transcribeSource({
        inputPath: input.inputPath, scratchDirectory, sourceId: source.sourceId, duration: source.duration,
        executionController, aiClient: ai, ...transcriptionOptions
      });
      transcripts.set(source.sourceId, transcript);
    }
    if (momentRequest.type === "exact") {
      candidates.push(...exactSpokenCandidates(transcript, momentRequest, source));
      continue;
    }
    let semanticResponse;
    try {
      semanticResponse = await generateWithRetries(ai, {
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        contents: buildSemanticTranscriptMatchPrompt({ source, moment: momentRequest, transcript }),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: createSemanticTranscriptMatchJsonSchema({ sourceId: source.sourceId, momentId: momentRequest.momentId })
        }
      }, retryOptions);
    } catch (error) {
      throw spokenMomentError(isTransientPlanningError(error) ? "SPEECH_SEMANTIC_RETRIES_EXHAUSTED" : "SPEECH_SEMANTIC_REQUEST_FAILED", { sourceId: source.sourceId, momentId: momentRequest.momentId });
    }
    if (!semanticResponse.text) throw spokenMomentError("SPEECH_MALFORMED_SEMANTIC_RESPONSE", { sourceId: source.sourceId, momentId: momentRequest.momentId });
    let parsedResponse;
    try { parsedResponse = JSON.parse(semanticResponse.text); }
    catch { throw spokenMomentError("SPEECH_MALFORMED_SEMANTIC_RESPONSE", { sourceId: source.sourceId, momentId: momentRequest.momentId }); }
    const validatedCandidates = validateSemanticTranscriptCandidates(parsedResponse, momentRequest, transcript, source);
    console.info("Semantic spoken moment candidates:", { sourceId: source.sourceId, momentId: momentRequest.momentId, segmentCount: transcript.segments.length, candidateCount: validatedCandidates.length });
    candidates.push(...validatedCandidates);
  }
  return resolveSpokenCandidates(candidates, momentRequest);
}

async function localizeVisualMoment({ momentRequest, sourceCatalog, resolvedSemanticSources, activeSources, ai, retryOptions }) {
  const targetSources = localizationSourcesForMoment(momentRequest, sourceCatalog, resolvedSemanticSources);
  const activeSourceById = new Map(activeSources.map((activeSource) => [activeSource.source.sourceId, activeSource]));
  const localizations = [];
  for (const source of targetSources) {
    const activeSource = activeSourceById.get(source.sourceId);
    if (!activeSource) throw visualMomentError("MOMENT_MISSING_SOURCE_LOCALIZATION", { sourceId: source.sourceId, momentId: momentRequest.momentId });
    let localizationResponse;
    try {
      localizationResponse = await generateWithRetries(ai, {
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        contents: buildSingleSourceContents(activeSource, buildVisualMomentLocalizationPrompt({ source, moment: momentRequest })),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: createVisualMomentLocalizationJsonSchema({ sourceId: source.sourceId, momentIds: [momentRequest.momentId] })
        }
      }, retryOptions);
    } catch (error) {
      logMomentLocalizationRequestFailure(source.sourceId, error);
      throw visualMomentError(undefined, { momentId: momentRequest.momentId });
    }
    if (!localizationResponse.text) throw visualMomentError("MOMENT_MALFORMED_RESPONSE", { sourceId: source.sourceId, momentId: momentRequest.momentId });
    let parsedResponse;
    try { parsedResponse = JSON.parse(localizationResponse.text); }
    catch { throw visualMomentError("MOMENT_MALFORMED_RESPONSE", { sourceId: source.sourceId, momentId: momentRequest.momentId }); }
    console.info("Gemini visual moment localization:", {
      sourceId: source.sourceId,
      momentId: momentRequest.momentId,
      candidateCount: Array.isArray(parsedResponse?.moments?.[0]?.candidates) ? parsedResponse.moments[0].candidates.length : null,
      candidates: Array.isArray(parsedResponse?.moments?.[0]?.candidates)
        ? parsedResponse.moments[0].candidates.map((candidate) => ({ start: candidate?.start ?? null, end: candidate?.end ?? null }))
        : null
    });
    localizations.push({ expectedSourceId: source.sourceId, response: parsedResponse });
  }
  return resolveVisualMomentLocalizations(localizations, momentRequest, sourceCatalog, targetSources.map((source) => source.sourceId));
}

function validateResolvedSemanticSourcesInPlan(plan, resolvedSemanticSources) {
  if (!resolvedSemanticSources.length) return;
  const sequence = plan.version === "2" && plan.operations.find((operation) => operation.type === "sequence");
  if (!sequence || !Array.isArray(sequence.clips)) {
    throw semanticSelectionError("SEMANTIC_FINAL_PLAN_MISMATCH", {
      expectedSourceIds: resolvedSemanticSources.map(({ sourceId }) => sourceId),
      sequencePresent: Boolean(sequence)
    });
  }

  let clipIndex = 0;
  for (const { sourceId } of resolvedSemanticSources) {
    clipIndex = sequence.clips.findIndex((clip, index) => index >= clipIndex && clip.sourceId === sourceId);
    if (clipIndex === -1) {
      throw semanticSelectionError("SEMANTIC_FINAL_PLAN_MISMATCH", {
        expectedSourceId: sourceId,
        sequenceClipCount: sequence.clips.length
      });
    }
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

async function createGeminiPlan({ sourceInputs, prompt, hasMultipleVideos, sourceCatalog, aiClient, retryOptions, scratchDirectory, executionController, transcriptionOptions }) {
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const uploadedFiles = [];
  const composition = extractMomentCompositionRequests(prompt, sourceCatalog);
  if (composition?.error) {
    throw visualMomentError(composition.error, { clauseIndex: composition.clauseIndex || null, count: composition.count || null });
  }
  const compositionRequests = composition?.requests || null;
  const semanticReferences = compositionRequests ? [] : extractSemanticSourceReferences(prompt, sourceCatalog);
  const spokenMomentRequest = compositionRequests ? null : extractSpokenMomentRequest(prompt, sourceCatalog);
  const momentRequest = compositionRequests ? null : extractVisualMomentRequest(prompt, sourceCatalog);
  const requiresVisualUnderstanding = semanticReferences.length > 0;
  if (requiresVisualUnderstanding) {
    console.info("Gemini semantic source references extracted:", { semanticReferences });
  }
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
          let classificationResponse;
          try {
            classificationResponse = await generateWithRetries(ai, {
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
          } catch (error) {
            logClassificationRequestFailure(activeSource.source.sourceId, error);
            throw semanticSelectionError();
          }
          if (!classificationResponse.text) {
            throw semanticSelectionError("SEMANTIC_MALFORMED_RESPONSE", { sourceId: activeSource.source.sourceId });
          }
          let parsedResponse;
          try {
            parsedResponse = JSON.parse(classificationResponse.text);
          } catch {
            throw semanticSelectionError("SEMANTIC_MALFORMED_RESPONSE", { sourceId: activeSource.source.sourceId });
          }
          logClassificationResponse(activeSource.source.sourceId, parsedResponse, semanticReferences);
          classifications.push({
            expectedSourceId: activeSource.source.sourceId,
            response: parsedResponse
          });
        }
        resolvedSemanticSources = resolveSemanticSourceClassifications(classifications, semanticReferences, sourceCatalog);
      } catch (error) {
        if (error instanceof UnsupportedEditRequestError) throw error;
        throw semanticSelectionError();
      }
    }

    const transcripts = new Map();
    const requests = compositionRequests || [spokenMomentRequest || momentRequest].filter(Boolean);
    const localizedMoments = [];
    for (const request of requests) {
      const localizedMoment = request.type
        ? await localizeSpokenMoment({ momentRequest: request, sourceCatalog, resolvedSemanticSources, sourceInputs, ai, retryOptions, scratchDirectory, executionController, transcriptionOptions, transcripts })
        : await localizeVisualMoment({ momentRequest: request, sourceCatalog, resolvedSemanticSources, activeSources, ai, retryOptions });
      localizedMoments.push(localizedMoment);
    }

    const response = await generateWithRetries(ai, {
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents: buildMultiSourceContents(activeSources, buildAiEditorPrompt({
        prompt, hasMultipleVideos, sourceCatalog, resolvedSemanticSources,
        authoritativeMomentSequence: localizedMoments.length ? localizedMoments.map(({ sourceId, start, end }) => ({ sourceId, start, end })) : null
      })),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) })
      }
    }, retryOptions);

    if (!response.text) throw new Error("Gemini returned no edit plan");
    let plan = JSON.parse(response.text);
    if (!Array.isArray(plan.operations)) throw new Error("Gemini returned a malformed edit plan");
    const authoritativeSequenceOptions = requests.some((request) => request.type)
      ? { reject: spokenMomentError, mismatchReason: "SPEECH_SOURCE_MISMATCH" }
      : {};
    if (compositionRequests && new Set(localizedMoments.map((moment) => moment.sourceId)).size > 1) {
      authoritativeSequenceOptions.rejectSourceScopedOperations = true;
    }
    if (localizedMoments.length) plan = applyAuthoritativeMomentSequence(plan, localizedMoments, authoritativeSequenceOptions);
    if (!plan.operations.length) {
      if (requiresVisualUnderstanding) logSemanticFinalPlanMismatch(plan);
      throw new UnsupportedEditRequestError("This edit is not supported yet");
    }
    if (requiresVisualUnderstanding && plan.version !== "2") {
      logSemanticFinalPlanMismatch(plan);
      throw new UnsupportedEditRequestError("This source description could not be identified confidently");
    }
    validateResolvedSemanticSourcesInPlan(plan, resolvedSemanticSources);
    return { plan: addAutomaticMerge(collapseGlobalSourceColorGrades(plan), hasMultipleVideos), transcripts };
  } finally {
    await Promise.all(uploadedFiles.filter((file) => file?.name).map((file) =>
      ai.files.delete({ name: file.name }).catch((error) => {
        console.warn("Unable to delete Gemini upload:", error.message);
      })
    ));
  }
}

export async function createAiEditPlan({ inputPath, inputMimeType, sourceInputs, prompt, hasMultipleVideos = false, sourceCatalog = [], aiClient, retryOptions, scratchDirectory, executionController, transcriptionOptions }) {
  const planningSources = sourceInputs?.length
    ? sourceInputs
    : inputPath ? [{ inputPath, inputMimeType, source: sourceCatalog[0] }] : [];
  const requiresVisualUnderstanding = requiresVisualSourceUnderstanding(prompt, sourceCatalog) || requiresMomentCompositionUnderstanding(prompt, sourceCatalog) || requiresVisualMomentUnderstanding(prompt, sourceCatalog) || requiresSpokenMomentUnderstanding(prompt, sourceCatalog);
  if (!process.env.GEMINI_API_KEY || !prompt.trim()) {
    if (requiresVisualUnderstanding) throw new UnsupportedEditRequestError("This edit needs Gemini video understanding");
    return {
      plan: createEditPlan({ prompt, hasMultipleVideos, sourceCatalog }),
      source: "deterministic"
    };
  }

  try {
    return {
      ...(await createGeminiPlan({ sourceInputs: planningSources, prompt, hasMultipleVideos, sourceCatalog, aiClient, retryOptions, scratchDirectory, executionController, transcriptionOptions })),
      source: "gemini"
    };
  } catch (error) {
    if (error instanceof EditExecutionCancelledError) throw error;
    if (error instanceof UnsupportedEditRequestError) throw error;
    if (requiresVisualUnderstanding) {
      const spoken = requiresSpokenMomentUnderstanding(prompt, sourceCatalog);
      console.error(spoken ? "Gemini spoken planning failed:" : "Gemini visual planning failed:", {
        ...(spoken ? { reason: error?.reason || "SPEECH_TRANSCRIPTION_FAILED" } : {}),
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

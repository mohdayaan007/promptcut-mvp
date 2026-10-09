import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MAX_DIRECT_UPLOAD_FILE_BYTES, JOB_STATUSES, validateJobRequest, validateUploadManifest } from "@/lib/jobs/job-config";
import { buildNormalizationFilter, createMediaProfile } from "@/lib/editor-core/media-profile";
import { DIRECT_UPLOAD_CORS } from "@/lib/jobs/storage";
import { safeSourceMetadata } from "@/lib/jobs/http";
import { ACTIVE_JOB_STATUSES, isActiveJobStatus, isRecoverableJobStatus } from "@/lib/client/direct-upload";
import { EDIT_JOBS_SCHEMA } from "@/lib/jobs/job-store";
import { createEditPlan, extractMomentCompositionRequests, extractSemanticSourceReferences, extractSpokenMomentRequest, extractVisualMomentRequest, requiresMomentCompositionUnderstanding, requiresSpokenMomentUnderstanding, requiresVisualMomentUnderstanding, requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { createEditPlanJsonSchema, createSemanticSourceClassificationJsonSchema, createSemanticTranscriptMatchJsonSchema, createVisualMomentLocalizationJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { createAiEditPlan, resolveSemanticSourceClassifications, resolveVisualMomentLocalizations, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import { buildAiEditorPrompt, buildSemanticTranscriptMatchPrompt, buildVisualMomentLocalizationPrompt } from "@/lib/editor-core/ai-editor/prompt";
import { createExecutionController, EditExecutionCancelledError, executeEditPlan } from "@/lib/editor-core/edit-executor";
import { TranscriptValidationError, createCanonicalTranscript, findPhraseOccurrences, normalizePhrase, pairPhraseOccurrences, validateTranscriptWords } from "@/lib/editor-core/spoken-transcript";
import { extractSpeechAudio, transcribeSource, wordAnnotations, SpokenTranscriptionError } from "@/lib/editor-core/spoken-transcription";
import { FONT_CATALOG, resolveFontId, resolveSemanticFontIntent } from "@/lib/title-config";
import { buildAssDocument } from "@/lib/title-renderer";
import { parseTitle } from "@/lib/title-parser";
import { applyCaptionCorrection, CaptionError, createCaptionCues, extractCaptionCorrection, extractCaptionStyleRequest, mapCaptionCuesToOutput, requestsCaptions } from "@/lib/editor-core/caption-engine";

const execFileAsync = promisify(execFile);

const video = { name: "source.mp4", type: "video/mp4", size: 1024 };
const sourceCatalog = createSourceCatalog(
  [
    { ...video, index: 0, name: "A.mp4" },
    { ...video, index: 1, name: "B.mp4" },
    { ...video, index: 2, name: "C.mp4" }
  ],
  [
    { duration: 20, width: 1920, height: 1080 },
    { duration: 30, width: 1280, height: 720 },
    { duration: 40, width: 1080, height: 1920 }
  ]
);

function plannerSources(catalog = sourceCatalog) {
  return catalog.map((source) => ({ inputPath: `/tmp/${source.sourceId}.mp4`, inputMimeType: "video/mp4", source }));
}

function createMockGemini({ responseText, responses = [], failures = [], transcriptionInteractions = [] } = {}) {
  const uploads = [];
  const deletes = [];
  const requests = [];
  let generateCalls = 0;
  const interactionRequests = [];
  return {
    uploads, deletes, requests, interactionRequests,
    files: {
      upload: async ({ file }) => {
        const uploaded = { name: `files/${uploads.length + 1}`, uri: `gemini://${file}`, mimeType: "video/mp4", state: "ACTIVE" };
        uploads.push(uploaded);
        return uploaded;
      },
      get: async ({ name }) => uploads.find((file) => file.name === name),
      delete: async ({ name }) => { deletes.push(name); }
    },
    models: {
      generateContent: async (request) => {
        requests.push(request);
        const responseIndex = generateCalls++;
        const failure = failures[responseIndex];
        if (failure) throw failure;
        return { text: responses[responseIndex] ?? responseText };
      }
    },
    interactions: {
      create: async (request) => { interactionRequests.push(request); return transcriptionInteractions.shift() || { steps: [] }; }
    }
  };
}

function classificationResponse(sourceId, matches) {
  return JSON.stringify({ sourceId, matches });
}

function momentLocalizationResponse(sourceId, candidates, momentId = "moment-1") {
  return JSON.stringify({ sourceId, moments: [{ momentId, candidates }] });
}
function semanticTranscriptResponse(sourceId, candidates, momentId = "moment-1") {
  return JSON.stringify({ sourceId, momentId, candidates });
}

function fullSequence(catalog = sourceCatalog, sourceIds = catalog.map((source) => source.sourceId)) {
  return {
    version: "2",
    operations: [{ type: "sequence", clips: sourceIds.map((sourceId) => {
      const source = catalog.find((entry) => entry.sourceId === sourceId);
      return { sourceId, start: 0, end: source.duration };
    }) }]
  };
}

async function withGeminiKey(callback) {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try { return await callback(); } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
}

async function assertSpokenRejection(promiseFactory, expectedReason) {
  const originalError = console.error;
  const reasons = [];
  console.error = (message, details) => {
    if (message === "Spoken moment localization rejected:") reasons.push(details?.reason);
  };
  try {
    await assert.rejects(promiseFactory, UnsupportedEditRequestError);
  } finally {
    console.error = originalError;
  }
  assert.ok(reasons.includes(expectedReason), `expected ${expectedReason}, received ${reasons.join(", ")}`);
}

function createMockChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function successfulSpawn(calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    const child = createMockChild(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}
function transcriptionMock({ interactions = [], uploadError, deleteError } = {}) {
  const calls = { uploads: [], interactions: [], deletes: [] };
  return { calls, files: {
    upload: async (request) => { calls.uploads.push(request); if (uploadError) throw uploadError; return { name: "audio-file", uri: "private-uri", mimeType: "audio/m4a" }; },
    delete: async (request) => { calls.deletes.push(request); if (deleteError) throw deleteError; }
  }, interactions: { create: async (request) => { calls.interactions.push(request); const value = interactions.shift(); if (value instanceof Error) throw value; return value || { steps: [] }; } } };
}
function interaction(words = [{ text: "Hello", start_offset: "1s", end_offset: "1.4s" }]) { return { steps: [{ content: [{ annotations: words.map((word) => ({ type: "word_info", ...word })) }] }] }; }

const transcriptWords = [
  { text: "Welcome", start: 1, end: 1.3 }, { text: "to", start: 1.3, end: 1.4 }, { text: "Kerala!", start: 1.4, end: 1.9 },
  { text: "The", start: 2.8, end: 3 }, { text: "Pro", start: 3, end: 3.2 }, { text: "plan", start: 3.2, end: 3.5 }, { text: "costs", start: 3.5, end: 3.8 }, { text: "twelve", start: 3.8, end: 4.1 }, { text: "dollars.", start: 4.1, end: 4.5 },
  { text: "Clip", start: 5.5, end: 5.8 }, { text: "or", start: 5.8, end: 5.9 }, { text: "Not.", start: 5.9, end: 6.3 }
];
function transcript(words = transcriptWords) { return createCanonicalTranscript({ sourceId: "source-1", duration: 10, words }); }
function speechCatalog(catalog = sourceCatalog) { return catalog.map((source) => ({ ...source, hasAudio: true })); }

test("spoken transcript validation rejects malformed and non-monotonic words", () => {
  assert.deepEqual(validateTranscriptWords({ sourceId: "source-1", duration: 2, words: [{ text: "Hi", start: 0, end: 1 }] }), [{ text: "Hi", start: 0, end: 1 }]);
  for (const words of [[{ text: "x", start: -1, end: 0 }], [{ text: "x", start: 0, end: Infinity }], [{ text: "x", start: 1, end: 0 }], [{ text: "x", start: 0, end: 3 }], [{ text: "a", start: 1, end: 2 }, { text: "b", start: 1.5, end: 2.1 }]]) {
    assert.throws(() => validateTranscriptWords({ sourceId: "source-1", duration: 2, words }), TranscriptValidationError);
  }
});

test("spoken transcript segmentation is stable and uses sentence/pause boundaries", () => {
  const first = transcript(); const second = transcript();
  assert.deepEqual(first, second);
  assert.deepEqual(first.segments.map(({ segmentId, start, end }) => ({ segmentId, start, end })), [
    { segmentId: "source-1-seg-1", start: 1, end: 1.9 }, { segmentId: "source-1-seg-2", start: 2.8, end: 4.5 }, { segmentId: "source-1-seg-3", start: 5.5, end: 6.3 }
  ]);
});

test("spoken phrase normalization covers punctuation, contractions, numbers, and currency", () => {
  assert.equal(normalizePhrase(" Welcome   to Kerala! "), "welcome to kerala");
  assert.equal(normalizePhrase("I'm here"), "i am here");
  assert.equal(normalizePhrase("$12"), normalizePhrase("twelve dollars"));
});

test("spoken phrase occurrences are exact/near-exact, contiguous, and preserve ambiguity", () => {
  assert.equal(findPhraseOccurrences(transcript(), "WELCOME to Kerala").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "The Pro plan costs $12").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "Cliponaut").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "unrelated vaguely similar idea").length, 0);
  const repeated = transcript([...transcriptWords, { text: "Welcome", start: 7, end: 7.3 }, { text: "to", start: 7.3, end: 7.4 }, { text: "Kerala.", start: 7.4, end: 7.9 }]);
  assert.equal(findPhraseOccurrences(repeated, "welcome to kerala").length, 2);
});

test("spoken phrase matching prefers exact windows before near-exact fallback", () => {
  const productionTranscript = transcript([
    { text: "Hello", start: 0.2, end: 0.5 }, { text: "team", start: 0.5, end: 0.8 }, { text: "TechStars", start: 0.8, end: 1.3 },
    { text: "I", start: 1.3, end: 1.4 }, { text: "am", start: 1.4, end: 1.6 }, { text: "Mohammed.", start: 1.6, end: 2.1 }
  ]);
  const productionMatches = findPhraseOccurrences(productionTranscript, "Hello, team TechStars");
  assert.deepEqual(productionMatches.map(({ start, end }) => ({ start, end })), [{ start: 0.2, end: 1.3 }]);

  const exactAndNear = transcript([
    { text: "Welcome", start: 0, end: 0.3 }, { text: "everyone.", start: 0.3, end: 0.8 },
    { text: "Welcome", start: 2, end: 2.3 }, { text: "everyon.", start: 2.3, end: 2.8 }
  ]);
  assert.deepEqual(findPhraseOccurrences(exactAndNear, "Welcome everyone").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 0.8 }]);

  const nearOnly = transcript([
    { text: "Clip", start: 0, end: 0.3 }, { text: "or", start: 0.3, end: 0.4 }, { text: "Not.", start: 0.4, end: 0.8 }
  ]);
  assert.deepEqual(findPhraseOccurrences(nearOnly, "Cliponaut").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 0.8 }]);
});

test("whole-window normalization matches contractions without annotation-count assumptions", () => {
  const founderWords = [
    { text: "I'm", start: 0, end: 0.3 }, { text: "a", start: 0.3, end: 0.4 }, { text: "solo", start: 0.4, end: 0.8 }, { text: "founder", start: 0.8, end: 1.2 },
    { text: "of", start: 1.2, end: 1.4 }, { text: "Clip", start: 1.4, end: 1.7 }, { text: "or", start: 1.7, end: 1.8 }, { text: "Not.", start: 1.8, end: 2.1 }
  ];
  const founderPhrase = "I'm a solo founder";
  assert.equal(normalizePhrase(founderPhrase).split(" ").length, 5);
  assert.equal(founderWords.slice(0, 4).length, 4);
  assert.deepEqual(findPhraseOccurrences(transcript(founderWords), founderPhrase).map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.2 }]);
  assert.deepEqual(findPhraseOccurrences(transcript(founderWords), "Cliponaut").map(({ start, end }) => ({ start, end })), [{ start: 1.4, end: 2.1 }]);

  const multipleContractions = transcript([
    { text: "I'm", start: 0, end: 0.3 }, { text: "sure", start: 0.3, end: 0.6 }, { text: "you're", start: 0.6, end: 1 }, { text: "ready.", start: 1, end: 1.4 }
  ]);
  assert.deepEqual(findPhraseOccurrences(multipleContractions, "I am sure you are ready").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.4 }]);

  const repeated = transcript([
    ...founderWords.slice(0, 4),
    { text: "Later.", start: 3, end: 3.4 },
    { text: "I'm", start: 4, end: 4.3 }, { text: "a", start: 4.3, end: 4.4 }, { text: "solo", start: 4.4, end: 4.8 }, { text: "founder.", start: 4.8, end: 5.2 }
  ]);
  assert.equal(findPhraseOccurrences(repeated, founderPhrase).length, 2);

  const exactAndNear = transcript([
    ...founderWords.slice(0, 4),
    { text: "I'm", start: 3, end: 3.3 }, { text: "a", start: 3.3, end: 3.4 }, { text: "solo", start: 3.4, end: 3.8 }, { text: "foundr.", start: 3.8, end: 4.2 }
  ]);
  assert.deepEqual(findPhraseOccurrences(exactAndNear, founderPhrase).map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.2 }]);
});

test("spoken phrase ranges and ordered pairs remain deterministic", () => {
  const value = transcript();
  const start = findPhraseOccurrences(value, "welcome to kerala", "START_BOUNDARY");
  const end = findPhraseOccurrences(value, "cliponaut", "END_BOUNDARY");
  assert.deepEqual(start[0].start, 1); assert.deepEqual(start[0].end, 1.9);
  assert.deepEqual(pairPhraseOccurrences(start, end).map(({ start: left, end: right }) => ({ start: left, end: right })), [{ start: 1, end: 6.3 }]);
  assert.deepEqual(pairPhraseOccurrences(end, start), []);
});

test("spoken routing takes exact and semantic speech out of visual localization", () => {
  const one = speechCatalog([sourceCatalog[0]]);
  const exact = extractSpokenMomentRequest('Use the part where she says "Welcome".', one);
  assert.deepEqual(exact, { momentId: "moment-1", type: "exact", mode: "EVENT_SEGMENT", startPhrase: "Welcome", sourceScope: { type: "single", sourceId: "source-1" } });
  assert.equal(extractVisualMomentRequest('Use the part where she says "Welcome".', one), null);
  const semantic = extractSpokenMomentRequest("Start when I begin talking about Cliponaut.", one);
  assert.equal(semantic.type, "semantic");
  assert.equal(requiresSpokenMomentUnderstanding("Start when I begin talking about Cliponaut.", one), true);
  assert.equal(extractVisualMomentRequest("Start when I begin talking about Cliponaut.", one), null);
  assert.ok(extractVisualMomentRequest("Use the part where the car enters the frame.", one));
});

test("semantic spoken parsing preserves modes and excludes visual routing", () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const event = extractSpokenMomentRequest("Use the part where I explain pricing.", catalog);
  const start = extractSpokenMomentRequest("Start when I begin talking about Cliponaut.", catalog);
  const end = extractSpokenMomentRequest("End when I start talking about integrations.", catalog);
  const paired = extractSpokenMomentRequest("Start when I begin talking about pricing and end when I begin talking about integrations.", catalog);
  assert.deepEqual(event, { momentId: "moment-1", type: "semantic", mode: "EVENT_SEGMENT", startTopicDescription: "pricing", sourceScope: { type: "single", sourceId: "source-1" } });
  assert.equal(start.mode, "START_BOUNDARY"); assert.equal(start.startTopicDescription, "Cliponaut");
  assert.equal(end.mode, "END_BOUNDARY"); assert.equal(end.endTopicDescription, "integrations");
  assert.equal(paired.mode, "START_END_BOUNDARY"); assert.equal(paired.startTopicDescription, "pricing"); assert.equal(paired.endTopicDescription, "integrations");
  assert.equal(extractVisualMomentRequest("Use the part where I explain pricing.", catalog), null);
});

test("semantic transcript schema and prompt use segment IDs rather than timestamps", () => {
  const schema = createSemanticTranscriptMatchJsonSchema({ sourceId: "source-1", momentId: "moment-1" });
  assert.deepEqual(Object.keys(schema.properties.candidates.items.properties).sort(), ["endSegmentId", "startSegmentId"]);
  const text = buildSemanticTranscriptMatchPrompt({ source: speechCatalog([sourceCatalog[0]])[0], moment: { momentId: "moment-1", mode: "EVENT_SEGMENT", startTopicDescription: "pricing" }, transcript: transcript() });
  assert.match(text, /segmentId/); assert.doesNotMatch(text, /"start"\s*:/);
});

test("semantic spoken matching derives coherent ranges and validates segment IDs", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const pricingWords = [
    { text: "Now", start_offset: "1s", end_offset: "1.2s" }, { text: "plans.", start_offset: "1.2s", end_offset: "1.6s" },
    { text: "Pricing", start_offset: "2.5s", end_offset: "2.9s" }, { text: "is", start_offset: "2.9s", end_offset: "3s" }, { text: "twelve.", start_offset: "3s", end_offset: "3.4s" },
    { text: "Unlimited", start_offset: "4.4s", end_offset: "4.8s" }, { text: "exports.", start_offset: "4.8s", end_offset: "5.3s" },
    { text: "Integrations.", start_offset: "6.3s", end_offset: "6.9s" }
  ];
  const aiClient = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-3" }]),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })
  ], transcriptionInteractions: [interaction(pricingWords)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where I explain pricing and make it black and white.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 5.3 }] }, { type: "color_grade", style: "bw" }]);
  assert.equal(aiClient.requests.length, 2);
});

test("semantic spoken ranges override final timestamps and reject conflicting source operations", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const words = [{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }];
  const override = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 9, end: 19 }] },
      { type: "color_grade", style: "bw" }
    ] })
  ], transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where I explain pricing and make it black and white.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: override,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 2, end: 2.5 }] },
    { type: "color_grade", style: "bw" }
  ]);

  const conflict = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [{ type: "color_grade", sourceId: "source-2", style: "bw" }] })
  ], transcriptionInteractions: [interaction(words)] });
  await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
    prompt: "From video 1, use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: conflict,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), "SPEECH_SOURCE_MISMATCH"));
});

test("semantic spoken response rejects malformed, unknown, and reversed segment references", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Pricing.", start_offset: "1s", end_offset: "1.5s" },
    { text: "Integrations.", start_offset: "2.5s", end_offset: "3s" }
  ];
  const invalid = [
    { responseText: semanticTranscriptResponse("source-2", []), reason: "SPEECH_SOURCE_MISMATCH" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "missing", endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_UNKNOWN_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "missing" }]), reason: "SPEECH_UNKNOWN_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_INVALID_SEGMENT_RANGE" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "moment-1", candidates: [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1", start: 999, end: 120 }] }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" },
    { responseText: semanticTranscriptResponse("source-1", [{ endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_MISSING_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1" }]), reason: "SPEECH_MISSING_SEGMENT" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "moment-1", candidates: null }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "wrong", candidates: [] }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" }
  ];
  for (const { responseText, reason } of invalid) {
    await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
      prompt: "Use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
      aiClient: createMockGemini({ responses: [responseText], transcriptionInteractions: [interaction(words)] }), scratchDirectory: "/scratch",
      transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
    }), reason));
  }
});

test("semantic matching retries transient calls without retranscribing and derives boundary modes", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Pricing.", start_offset: "2s", end_offset: "2.5s" },
    { text: "Integrations.", start_offset: "5s", end_offset: "5.5s" }
  ];
  const busy = Object.assign(new Error("busy"), { status: 429 });
  const retrying = createMockGemini({ failures: [busy, busy], responses: [undefined, undefined,
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] })
  ], transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Start when I begin talking about pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: retrying,
    retryOptions: { sleepFn: async () => {} }, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 2, end: 20 }]);
  assert.equal(retrying.interactionRequests.length, 1);
  const ending = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-2" }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] })
  ], transcriptionInteractions: [interaction(words)] });
  const endResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "End when I start talking about integrations.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ending,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(endResult.plan.operations[0].clips, [{ sourceId: "source-1", start: 0, end: 5.5 }]);
});

test("semantic matcher retry and failure matrix preserves its one canonical transcript", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [{ text: "Pricing.", start_offset: "1s", end_offset: "1.5s" }];
  const run = ({ failures = [], responses = [] }) => {
    const aiClient = createMockGemini({ failures, responses, transcriptionInteractions: [interaction(words)] });
    return { aiClient, promise: withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, retryOptions: { sleepFn: async () => {} }, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } })) };
  };
  for (const transient of [429, 503]) {
    const error = Object.assign(new Error("busy"), { status: transient });
    const { aiClient, promise } = run({ failures: [error], responses: [undefined, semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]), JSON.stringify(fullSequence(catalog))] });
    await promise;
    assert.equal(aiClient.interactionRequests.length, 1);
    assert.equal(aiClient.requests.length, 3);
  }
  const exhausted = run({ failures: [503, 503, 503].map((status) => Object.assign(new Error("busy"), { status })) });
  await assert.rejects(exhausted.promise, UnsupportedEditRequestError);
  assert.equal(exhausted.aiClient.interactionRequests.length, 1); assert.equal(exhausted.aiClient.requests.length, 3);
  const nonTransient = run({ failures: [Object.assign(new Error("bad"), { status: 400 })] });
  await assert.rejects(nonTransient.promise, UnsupportedEditRequestError);
  assert.equal(nonTransient.aiClient.interactionRequests.length, 1); assert.equal(nonTransient.aiClient.requests.length, 1);
  const malformed = run({ responses: ["not-json"] });
  await assert.rejects(malformed.promise, UnsupportedEditRequestError);
  assert.equal(malformed.aiClient.interactionRequests.length, 1); assert.equal(malformed.aiClient.requests.length, 1);
});

test("ordinary visual moments remain on the visual path without speech transcription", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 7 }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 7 }] }] })
  ] });
  assert.equal(requiresSpokenMomentUnderstanding("Use the part where the car enters the frame.", catalog), false);
  assert.ok(requiresVisualMomentUnderstanding("Use the part where the car enters the frame.", catalog));
  await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where the car enters the frame.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }));
  assert.equal(aiClient.interactionRequests.length, 0);
});

test("exact spoken modes create server-authoritative V2 ranges without visual localization", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const cases = [
    ['Use the part where she says "Welcome to Kerala".', { start: 1, end: 1.9 }],
    ['Start when I say "Welcome to Kerala".', { start: 1, end: 20 }],
    ['End after he says "Cliponaut".', { start: 0, end: 6.3 }],
    ['Start when I say "Welcome to Kerala" and end when I say "Cliponaut".', { start: 1, end: 6.3 }]
  ];
  for (const [prompt, range] of cases) {
    const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }), transcriptionInteractions: [interaction(transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` })))] });
    const result = await withGeminiKey(() => createAiEditPlan({ prompt, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
    assert.deepEqual(result.plan.operations[0], { type: "sequence", clips: [{ sourceId: "source-1", ...range }] });
    assert.deepEqual(result.plan.operations[1], { type: "color_grade", style: "bw" });
    assert.equal(aiClient.requests.length, 1);
  }
});

test("exact spoken orchestration keeps a unique phrase boundary when later words continue", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Hello", start_offset: "0.2s", end_offset: "0.5s" }, { text: "team", start_offset: "0.5s", end_offset: "0.8s" }, { text: "TechStars", start_offset: "0.8s", end_offset: "1.3s" },
    { text: "I", start_offset: "1.3s", end_offset: "1.4s" }, { text: "am", start_offset: "1.4s", end_offset: "1.6s" }, { text: "Mohammed.", start_offset: "1.6s", end_offset: "2.1s" }
  ];
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Hello, team TechStars".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0.2, end: 1.3 }] }]);
});

test("exact spoken START boundary handles contraction-expanded phrases once", async () => {
  const catalog = speechCatalog([{ ...sourceCatalog[0], duration: 10.625 }]);
  const words = [
    { text: "I'm", start_offset: "1.1s", end_offset: "1.4s" }, { text: "a", start_offset: "1.4s", end_offset: "1.5s" }, { text: "solo", start_offset: "1.5s", end_offset: "1.9s" }, { text: "founder", start_offset: "1.9s", end_offset: "2.4s" },
    { text: "building", start_offset: "2.4s", end_offset: "2.8s" }, { text: "Cliponaut.", start_offset: "2.8s", end_offset: "3.4s" }
  ];
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Start when I say "I\'m a solo founder".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1.1, end: 10.625 }] }]);
});

test("Stage 3 preserves Cliponaut normalization and global B&W beside the authoritative spoken range", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responseText: JSON.stringify({ version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] },
      { type: "color_grade", style: "bw" }
    ] }),
    transcriptionInteractions: [interaction(transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` })))]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Cliponaut" and make it black and white.', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 5.5, end: 6.3 }] },
    { type: "color_grade", style: "bw" }
  ]);
});

test("spoken exact matching preserves normalization, ambiguity, source scoping, and final-plan protection", async () => {
  const catalog = speechCatalog(sourceCatalog);
  const words = transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` }));
  const explicit = createMockGemini({ responseText: JSON.stringify(fullSequence(catalog)), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: 'From video 2, use the part where I say "$12".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: explicit, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(explicit.uploads.filter((file) => file.uri.includes("speech.m4a")).map((file) => file.uri), ["gemini:///scratch/source-2-speech.m4a"]);
  assert.equal(result.plan.operations[0].clips[0].sourceId, "source-2");
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: createMockGemini(), scratchDirectory: "/scratch" }),
    UnsupportedEditRequestError
  ));
  const repeated = [...words, { text: "Welcome", start_offset: "7s", end_offset: "7.3s" }];
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', sourceCatalog: speechCatalog([sourceCatalog[0]]), sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: createMockGemini({ transcriptionInteractions: [interaction(repeated)] }), scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }),
    UnsupportedEditRequestError
  ));
});

test("final planner timestamps never replace a resolved spoken range", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responseText: JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 9, end: 15 }] }] }),
    transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.4s" }])]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 1.4 }] }]);
});

test("semantic video scope resolves before transcribing only the resolved spoken source", async () => {
  const catalog = speechCatalog(sourceCatalog);
  const words = transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` }));
  const aiClient = createMockGemini({
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      JSON.stringify(fullSequence(catalog))
    ],
    transcriptionInteractions: [interaction(words)]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'From the talking clip, use the part where I say "Welcome to Kerala".', hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.equal(aiClient.uploads.filter((file) => file.uri.includes("speech.m4a")).length, 1);
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 1, end: 1.9 }]);
});

test("unscoped exact speech aggregates every source without upload-order selection", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const onlySecond = createMockGemini({
    responseText: JSON.stringify(fullSequence(catalog)),
    transcriptionInteractions: [
      interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]),
      interaction([{ text: "Welcome", start_offset: "2s", end_offset: "2.4s" }])
    ]
  });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: onlySecond, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 2.4 }]);
  assert.equal(onlySecond.interactionRequests.length, 2);
  const ambiguous = createMockGemini({ transcriptionInteractions: [
    interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.2s" }]),
    interaction([{ text: "Welcome", start_offset: "2s", end_offset: "2.2s" }])
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ambiguous, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
});

test("unscoped semantic speech matches one transcript per source and aggregates safely", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const pricing = [{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }];
  const unique = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }]),
    JSON.stringify(fullSequence(catalog))
  ], transcriptionInteractions: [interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]), interaction(pricing)] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: unique, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 2.5 }]);
  assert.equal(unique.interactionRequests.length, 2);
  const matcherPrompts = unique.requests.slice(0, 2).map((request) => request.contents);
  assert.match(matcherPrompts[0], /source-1-seg-1/); assert.doesNotMatch(matcherPrompts[0], /source-2-seg-1/);
  assert.match(matcherPrompts[1], /source-2-seg-1/); assert.doesNotMatch(matcherPrompts[1], /source-1-seg-1/);
  const ambiguous = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }])
  ], transcriptionInteractions: [interaction(pricing), interaction(pricing)] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ambiguous, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
  const noMatch = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [])
  ], transcriptionInteractions: [interaction(pricing), interaction(pricing)] });
  await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
    prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: noMatch,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), "SPEECH_NO_CANDIDATE"));
});

test("unscoped speech no-match and silent sources contribute zero candidates", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const noneExact = createMockGemini({ transcriptionInteractions: [
    interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]),
    interaction([{ text: "Else.", start_offset: "2s", end_offset: "2.2s" }])
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: noneExact, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
  const emptyThenUnique = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }]),
    JSON.stringify(fullSequence(catalog))
  ], transcriptionInteractions: [{ steps: [] }, interaction([{ text: "Pricing.", start_offset: "3s", end_offset: "3.5s" }])] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: emptyThenUnique, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 3, end: 3.5 }]);
});

test("spoken no-match, paired ambiguity, and final source mismatch reject safely", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const make = (words, responseText = JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })) => createAiEditPlan({
    prompt: 'Use the part where I say "Missing".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient: createMockGemini({ responseText, transcriptionInteractions: [interaction(words)] }), scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  });
  await withGeminiKey(() => assert.rejects(() => make([{ text: "Other", start_offset: "1s", end_offset: "1.2s" }]), UnsupportedEditRequestError));
  const repeatedPairs = [
    { text: "Welcome", start_offset: "1s", end_offset: "1.2s" }, { text: "Thanks", start_offset: "2s", end_offset: "2.2s" },
    { text: "Welcome", start_offset: "3s", end_offset: "3.2s" }, { text: "Thanks", start_offset: "4s", end_offset: "4.2s" }
  ];
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Start when I say "Welcome" and end when I say "Thanks".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient: createMockGemini({ transcriptionInteractions: [interaction(repeatedPairs)] }), scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), UnsupportedEditRequestError));
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), scratchDirectory: "/scratch",
    aiClient: createMockGemini({ responseText: JSON.stringify({ version: "2", operations: [{ type: "color_grade", sourceId: "source-2", style: "bw" }] }), transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.2s" }])] }),
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), UnsupportedEditRequestError));
});

test("a source without an audio stream rejects speech selection without transcription", async () => {
  const catalog = [{ ...sourceCatalog[0], hasAudio: false }];
  const aiClient = createMockGemini();
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient, scratchDirectory: "/scratch"
  }), UnsupportedEditRequestError));
  assert.equal(aiClient.uploads.filter((file) => file.uri.includes("speech.m4a")).length, 0);
});

test("spoken transcription annotations parse Gemini word_info offsets without assigning IDs", () => {
  assert.deepEqual(wordAnnotations({ steps: [{ content: [{ annotations: [{ type: "word_info", text: "Welcome", start_offset: "0.8s", end_offset: "1.2s" }, { type: "other", text: "ignored" }] }] }] }), [{ text: "Welcome", start: 0.8, end: 1.2 }]);
});

test("speech extraction uses only a caller scratch M4A with exact-child ownership", async () => {
  const calls = []; const child = createMockChild(); child.stderr = new EventEmitter();
  const controller = createExecutionController();
  const pending = extractSpeechAudio({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", executionController: controller, spawn: (command, args) => { calls.push({ command, args }); return child; } });
  assert.equal(calls[0].command, "ffmpeg"); assert.deepEqual(calls[0].args.slice(6, 15), ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k"]);
  controller.cancel(); assert.deepEqual(child.signals, ["SIGTERM"]); child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, EditExecutionCancelledError);
});

test("isolated transcription creates canonical server segments and cleans local/Gemini files", async () => {
  const spawns = []; const ai = transcriptionMock({ interactions: [interaction()] }); const removed = [];
  const result = await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), remove: async (file) => removed.push(file) });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 1); assert.equal(ai.calls.interactions[0].model, "gemini-3.5-transcribe");
  assert.equal(result.segments[0].segmentId, "source-1-seg-1"); assert.deepEqual(result.segments[0].words[0], { text: "Hello", start: 1, end: 1.4 });
  assert.equal(ai.calls.deletes.length, 1); assert.deepEqual(removed, ["/scratch/source-1-speech.m4a"]);
});

test("transcription retries only interactions and maps validation/request failures without masking cleanup", async () => {
  const transient = Object.assign(new Error("busy"), { status: 503 }); const ai = transcriptionMock({ interactions: [transient, transient, interaction()] }); const spawns = []; const removed = [];
  await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), sleep: async () => {}, remove: async (file) => removed.push(file) });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 3); assert.equal(ai.calls.deletes.length, 1); assert.equal(removed.length, 1);
  const badAi = transcriptionMock({ interactions: [interaction([{ text: "Bad", start_offset: "wat", end_offset: "2s" }])], deleteError: new Error("cleanup") });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: badAi, spawn: successfulSpawn(), remove: async () => { throw new Error("cleanup"); } }), (error) => error.reason === "SPEECH_INVALID_WORD_TIMESTAMPS");
  const nonTransient = transcriptionMock({ interactions: [Object.assign(new Error("bad"), { status: 400 })] });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: nonTransient, spawn: successfulSpawn() }), (error) => error.reason === "SPEECH_TRANSCRIPTION_REQUEST_FAILED");
  assert.equal(nonTransient.calls.interactions.length, 1);
});

test("Stage 2 retries 429s once per interaction and exhausts without re-uploading", async () => {
  const busy = Object.assign(new Error("busy"), { status: 429 }); const ai = transcriptionMock({ interactions: [busy, interaction()] }); const spawns = [];
  await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), sleep: async () => {} });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 2);
  const exhausted = transcriptionMock({ interactions: [busy, busy, busy] }); const exhaustedSpawns = [];
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: exhausted, spawn: successfulSpawn(exhaustedSpawns), sleep: async () => {} }), (error) => error.reason === "SPEECH_TRANSCRIPTION_RETRIES_EXHAUSTED");
  assert.equal(exhaustedSpawns.length, 1); assert.equal(exhausted.calls.uploads.length, 1); assert.equal(exhausted.calls.interactions.length, 3); assert.equal(exhausted.calls.deletes.length, 1);
});

test("Stage 2 cleans extraction/upload/request paths and preserves empty transcripts", async () => {
  const removed = []; const uploadFailure = transcriptionMock({ uploadError: new Error("upload") });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: uploadFailure, spawn: successfulSpawn(), remove: async (file) => removed.push(file) }));
  assert.equal(uploadFailure.calls.deletes.length, 0); assert.equal(removed.length, 1);
  const requestFailure = transcriptionMock({ interactions: [Object.assign(new Error("bad"), { status: 400 })] }); const requestRemoved = [];
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: requestFailure, spawn: successfulSpawn(), remove: async (file) => requestRemoved.push(file) }));
  assert.equal(requestFailure.calls.deletes.length, 1); assert.equal(requestRemoved.length, 1);
  const silent = transcriptionMock({ interactions: [{ steps: [] }], deleteError: new Error("cleanup") }); const result = await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: silent, spawn: successfulSpawn(), remove: async () => { throw new Error("cleanup"); } });
  assert.deepEqual(result, { sourceId: "source-1", segments: [] });
});

test("Stage 2 maps every malformed word shape without retrying", async () => {
  const invalid = [
    [{ text: "", start_offset: "1s", end_offset: "2s" }], [{ text: "x", start_offset: "NaNs", end_offset: "2s" }],
    [{ text: "x", start_offset: "-1s", end_offset: "2s" }], [{ text: "x", start_offset: "3s", end_offset: "2s" }],
    [{ text: "x", start_offset: "1s", end_offset: "9s" }], [{ text: "a", start_offset: "2s", end_offset: "3s" }, { text: "b", start_offset: "1s", end_offset: "2s" }]
  ];
  for (const words of invalid) {
    const ai = transcriptionMock({ interactions: [interaction(words)] });
    await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn() }), (error) => error.reason === "SPEECH_INVALID_WORD_TIMESTAMPS");
    assert.equal(ai.calls.interactions.length, 1); assert.equal(ai.calls.deletes.length, 1);
  }
});

test("direct-upload manifest accepts five bounded video files", () => {
  assert.equal(validateUploadManifest(Array.from({ length: 5 }, (_, index) => ({ ...video, name: `${index}.mp4` }))), 5120);
});

test("direct-upload manifest rejects over-limit source files", () => {
  assert.throws(() => validateUploadManifest([{ ...video, size: MAX_DIRECT_UPLOAD_FILE_BYTES + 1 }]), /5 GB/);
});

test("job request needs a prompt and a supported export quality", () => {
  assert.throws(() => validateJobRequest({ prompt: "", exportQuality: "standard", sources: [video] }), /Describe/);
  assert.throws(() => validateJobRequest({ prompt: "Black and white", exportQuality: "8k", sources: [video] }), /exportQuality/);
});

test("same-orientation mixed sources fill the common canvas", () => {
  const profile = createMediaProfile({ media: [{ width: 3840, height: 2160 }, { width: 1280, height: 720 }], exportQuality: "standard" });
  assert.match(buildNormalizationFilter(profile, { width: 1280, height: 720 }), /force_original_aspect_ratio=increase,crop=/);
});

test("direct upload CORS permits only Cliponaut and local development", () => {
  const [rule] = DIRECT_UPLOAD_CORS.CORSRules;
  assert.deepEqual(rule.AllowedOrigins, ["https://cliponaut.com", "http://localhost:3000"]);
  assert.deepEqual(rule.AllowedMethods, ["GET", "HEAD", "PUT"]);
  assert.deepEqual(rule.ExposeHeaders, ["ETag"]);
});

test("restored source metadata preserves order without storage keys", () => {
  const sources = safeSourceMetadata([
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500, key: "private/fifth" },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200, key: "private/second" },
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100, key: "private/first" },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400, key: "private/fourth" },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300, key: "private/third" }
  ]);
  assert.deepEqual(sources, [
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100 },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200 },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300 },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400 },
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500 }
  ]);
});

test("cancelled is a terminal durable-job status and is eligible for source cleanup", () => {
  assert.ok(JOB_STATUSES.includes("cancelled"));
  assert.match(EDIT_JOBS_SCHEMA, /'cancelled'/);
  assert.match(EDIT_JOBS_SCHEMA, /'completed','failed','cancelled'/);
  assert.ok(!ACTIVE_JOB_STATUSES.includes("cancelled"));
});

test("only active and completed jobs trigger recovery", () => {
  for (const status of ["uploading", "queued", "analyzing", "rendering"]) {
    assert.equal(isActiveJobStatus(status), true);
    assert.equal(isRecoverableJobStatus(status), true);
  }
  assert.equal(isRecoverableJobStatus("completed"), true);
  for (const status of ["failed", "cancelled"]) {
    assert.equal(isActiveJobStatus(status), false);
    assert.equal(isRecoverableJobStatus(status), false);
  }
});

test("normal execution controller leaves its active child unchanged", () => {
  const controller = createExecutionController();
  const child = createMockChild();
  controller.attach(child);
  assert.equal(controller.isCancelled(), false);
  assert.doesNotThrow(() => controller.throwIfCancelled());
  assert.deepEqual(child.signals, []);
  controller.detach(child);
});

test("cancelling an active execution gracefully terminates only its child", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  assert.equal(controller.cancel(), true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.throws(() => controller.throwIfCancelled(), EditExecutionCancelledError);

  child.exitCode = 0;
  controller.detach(child);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a non-exiting cancelled execution receives one bounded force kill", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  controller.cancel();
  controller.cancel();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a cancellation observed before execution starts prevents the next child from running", () => {
  const controller = createExecutionController({ setTimeoutFn: () => null });
  const child = createMockChild();
  controller.cancel();
  controller.attach(child);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(controller.cancel(), false);
});

test("source catalog has stable human-facing IDs at one, two, and five source scale", () => {
  assert.deepEqual(sourceCatalog.map(({ sourceId, ordinal, filename }) => ({ sourceId, ordinal, filename })), [
    { sourceId: "source-1", ordinal: 1, filename: "A.mp4" },
    { sourceId: "source-2", ordinal: 2, filename: "B.mp4" },
    { sourceId: "source-3", ordinal: 3, filename: "C.mp4" }
  ]);
  const one = createSourceCatalog([{ ...video, index: 0, name: "one.mp4" }], [{ duration: 10, width: 1920, height: 1080 }]);
  const two = createSourceCatalog(
    [{ ...video, index: 0, name: "one.mp4" }, { ...video, index: 1, name: "two.mp4" }],
    [{ duration: 10, width: 1920, height: 1080 }, { duration: 10, width: 1920, height: 1080 }]
  );
  assert.deepEqual(one.map((source) => source.sourceId), ["source-1"]);
  assert.deepEqual(two.map((source) => source.sourceId), ["source-1", "source-2"]);
  const five = createSourceCatalog(
    Array.from({ length: 5 }, (_, index) => ({ ...video, index, name: `${index}.mp4` })),
    Array.from({ length: 5 }, () => ({ duration: 10, width: 1920, height: 1080 }))
  );
  assert.equal(five[0].sourceId, "source-1");
  assert.equal(five[4].sourceId, "source-5");
});

test("source-aware fallback preserves requested two-source order", () => {
  const plan = createEditPlan({ prompt: "Put the second video first, then the first.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-aware fallback creates source-local trim clips", () => {
  const plan = createEditPlan({ prompt: "Use the first 5 seconds of video 1, followed by seconds 10-15 of video 2.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips, [
    { sourceId: "source-1", start: 0, end: 5 },
    { sourceId: "source-2", start: 10, end: 15 }
  ]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-specific color grade is scoped before sequence assembly", () => {
  const plan = createEditPlan({ prompt: "Make only video 2 black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0], {
    type: "sequence",
    clips: [
      { sourceId: "source-1", start: 0, end: 20 },
      { sourceId: "source-2", start: 0, end: 30 },
      { sourceId: "source-3", start: 0, end: 40 }
    ]
  });
  assert.deepEqual(plan.operations[1], { type: "color_grade", sourceId: "source-2", style: "bw" });
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("global multi-video color grades remain a single unscoped operation", () => {
  for (const prompt of ["Make both videos black and white.", "Make all videos black and white."]) {
    assert.equal(requiresVisualSourceUnderstanding(prompt, sourceCatalog), false);
    const plan = createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog });
    const colorGrades = plan.operations.filter((operation) => operation.type === "color_grade");
    assert.deepEqual(colorGrades, [{ type: "color_grade", style: "bw" }]);
    assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
  }
});

test("Gemini prompt distinguishes global and source-scoped color grades", () => {
  const prompt = buildAiEditorPrompt({ prompt: "Make both videos black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.match(prompt, /exactly one color_grade operation per plan/);
  assert.match(prompt, /both, all, or every video, use one unscoped color_grade without sourceId/);
  assert.match(prompt, /never emit one color_grade per source/);
  assert.match(prompt, /Use sourceId only when the request explicitly limits the grade to one source/);
});

test("single-video black and white keeps the version 1 global color grade", () => {
  const plan = createEditPlan({ prompt: "Make this video black and white." });
  assert.deepEqual(plan, { version: "1", operations: [{ type: "color_grade", style: "bw" }] });
  assert.doesNotThrow(() => validateEditPlan(plan));
});

test("validator still rejects duplicate source color grades", () => {
  const twoSourceCatalog = sourceCatalog.slice(0, 2);
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: twoSourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration })) },
    { type: "color_grade", sourceId: "source-1", style: "bw" },
    { type: "color_grade", sourceId: "source-2", style: "bw" }
  ] }, { sourceCatalog: twoSourceCatalog }), /only one color_grade operation is allowed/);
});

test("source-aware validation allows repeats but rejects bad sources and ranges", () => {
  const repeated = {
    version: "2", operations: [{ type: "sequence", clips: [
      { sourceId: "source-1", start: 0, end: 2 },
      { sourceId: "source-2", start: 0, end: 2 },
      { sourceId: "source-1", start: 2, end: 4 }
    ] }]
  };
  assert.doesNotThrow(() => validateEditPlan(repeated, { sourceCatalog }));
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-4", start: 0, end: 1 }] }] }, { sourceCatalog }), /unknown source/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: -1, end: 1 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 5, end: 5 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 21 }] }] }, { sourceCatalog }), /exceeds/);
});

test("version 2 rejects merge and source IDs on global-only operations", () => {
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "merge" }
  ] }, { sourceCatalog }), /cannot include merge/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "trim", sourceId: "source-1", start: 0, end: 1 }
  ] }, { sourceCatalog }), /sourceId is supported only/);
});

test("source-aware JSON schema limits source IDs to the supplied catalog", () => {
  const schema = createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /source-1/);
  assert.doesNotMatch(serialized, /source-4/);
});

test("semantic source extraction preserves order and skips explicit ordinals", () => {
  assert.deepEqual(extractSemanticSourceReferences("Use the talking clip first, then the greenery footage.", sourceCatalog), [
    { referenceId: "semantic-1", description: "talking clip" },
    { referenceId: "semantic-2", description: "greenery footage" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2 first, then the greenery clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery clip" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use the video showing the road.", sourceCatalog), [
    { referenceId: "semantic-1", description: "video showing road" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2, then video 1.", sourceCatalog), []);
});

test("semantic source extraction excludes explicit source-time phrases without losing semantic references", () => {
  const productionPrompt = 'Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2, and add the title "SECOND HALF" at 0:04.';
  assert.deepEqual(extractSemanticSourceReferences(productionPrompt, sourceCatalog), []);
  assert.equal(requiresVisualSourceUnderstanding(productionPrompt, sourceCatalog), false);
  assert.deepEqual(createEditPlan({ prompt: productionPrompt, hasMultipleVideos: true, sourceCatalog }).operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 3 }, { sourceId: "source-2", start: 0, end: 3 }] }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use the first 3 seconds of video 1, followed by seconds 5 to 8 of video 2.", sourceCatalog), []);
  assert.deepEqual(extractSemanticSourceReferences("Use the first 3 seconds of source-1, then the first 3 seconds of source-2.", sourceCatalog), []);
  assert.deepEqual(extractSemanticSourceReferences("Use the greenery video, then the talking clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery video" },
    { referenceId: "semantic-2", description: "talking clip" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2 first, then the greenery clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery clip" }
  ]);
});

test("semantic source classification schema constrains the assigned source and references", () => {
  const schema = createSemanticSourceClassificationJsonSchema({ sourceId: "source-1", referenceIds: ["semantic-1"] });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /plausibleMatch/);
  assert.match(serialized, /semantic-1/);
  assert.match(serialized, /source-1/);
  assert.doesNotMatch(serialized, /source-2/);
});

test("visual moment extraction recognizes structural event and boundary requests without timestamp parsing", () => {
  const oneSource = sourceCatalog.slice(0, 1);
  assert.deepEqual(extractVisualMomentRequest("Use the part where the car enters the driveway.", oneSource), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the car enters the driveway",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Keep the section where the cyclist reaches the bridge.", oneSource), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the cyclist reaches the bridge",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Start when the house appears.", oneSource), {
    momentId: "moment-1",
    mode: "START_BOUNDARY",
    startEventDescription: "the house appears",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Stop once she sits down.", oneSource), {
    momentId: "moment-1",
    mode: "END_BOUNDARY",
    endEventDescription: "she sits down",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Cut everything after she reaches the bridge.", oneSource), {
    momentId: "moment-1",
    mode: "END_BOUNDARY",
    endEventDescription: "she reaches the bridge",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Start when the door opens and end when she leaves.", oneSource), {
    momentId: "moment-1",
    mode: "START_END_BOUNDARY",
    startEventDescription: "the door opens",
    endEventDescription: "she leaves",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.equal(extractVisualMomentRequest("Trim from 0:05 to 0:10.", oneSource), null);
  assert.equal(requiresVisualMomentUnderstanding("Use the part where the car enters the driveway.", oneSource), true);
  assert.equal(requiresVisualMomentUnderstanding("Make this cinematic.", oneSource), false);
});

test("visual moment extraction scopes explicit and semantic source requests", () => {
  assert.deepEqual(extractVisualMomentRequest("From video 2, use the part where the person waves.", sourceCatalog), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the person waves",
    sourceScope: { type: "explicit", sourceId: "source-2" }
  });
  assert.deepEqual(extractVisualMomentRequest("From the greenery clip, use the part where the path appears.", sourceCatalog), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the path appears",
    sourceScope: { type: "semantic", referenceId: "semantic-1" }
  });
});

test("visual moment localization schema constrains the source, moment ID, and bounded candidates", () => {
  const schema = createVisualMomentLocalizationJsonSchema({ sourceId: "source-2", momentIds: ["moment-1"] });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /source-2/);
  assert.match(serialized, /moment-1/);
  assert.match(serialized, /candidates/);
  assert.doesNotMatch(serialized, /source-1/);
});

test("visual moment localization prompt requires the full visible event without ranking partial matches", () => {
  const prompt = buildVisualMomentLocalizationPrompt({
    source: sourceCatalog[0],
    moment: extractVisualMomentRequest("Use the part where the person walks through the temple.", sourceCatalog.slice(0, 1))
  });
  assert.match(prompt, /conjunction of all meaningful visible constraints/);
  assert.match(prompt, /every essential subject, object, action, setting, direction, relationship, and state/);
  assert.match(prompt, /Never return a partial semantic match/);
  assert.match(prompt, /Prefer a false negative/);
  assert.match(prompt, /do not choose a best occurrence/);
  assert.match(prompt, /forest or generic path/);
  assert.match(prompt, /Do not use filenames as visual evidence/);
});

test("visual moment localizations derive source-time ranges and reject ambiguous or malformed evidence", () => {
  const single = sourceCatalog.slice(0, 1);
  const eventRequest = extractVisualMomentRequest("Use the part where the car enters.", single);
  const startRequest = extractVisualMomentRequest("Start when the car enters.", single);
  const endRequest = extractVisualMomentRequest("End when the car leaves.", single);
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], eventRequest, single, ["source-1"]), { sourceId: "source-1", start: 3, end: 7 });
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], startRequest, single, ["source-1"]), { sourceId: "source-1", start: 3, end: 20 });
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], endRequest, single, ["source-1"]), { sourceId: "source-1", start: 0, end: 7 });

  const malformed = [
    [],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-2", moments: [] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "other", candidates: [] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: -1, end: 1 }] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: 3, end: 21 }] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: 3, end: 7 }, { start: 8, end: 9 }] }] } }]
  ];
  for (const localizations of malformed) {
    assert.throws(() => resolveVisualMomentLocalizations(localizations, eventRequest, single, ["source-1"]), /needs Gemini video understanding/);
  }
});

test("a unique single-source visual moment creates an authoritative V2 sequence", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const finalPlan = { version: "1", operations: [{ type: "color_grade", style: "bw" }] };
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 7 }]),
    JSON.stringify(finalPlan)
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the car enters, and make it black and white.", hasMultipleVideos: false,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan, {
    version: "2",
    operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 7 }] },
      { type: "color_grade", style: "bw" }
    ]
  });
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.requests[0].contents.filter((part) => part?.fileData).length, 1);
  assert.equal(aiClient.requests[1].contents.filter((part) => part?.fileData).length, 1);
  assert.match(aiClient.requests[1].contents.at(-1), /Authoritative localized sequence/);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog: catalog }));
});

test("visual start, end, and paired boundaries derive exact V2 source ranges", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const cases = [
    ["Start when the house appears.", { start: 4, end: 20 }],
    ["End when the person sits down.", { start: 0, end: 8 }],
    ["Start when the door opens and end when she leaves.", { start: 4, end: 8 }]
  ];
  for (const [prompt, expectedRange] of cases) {
    const aiClient = createMockGemini({ responses: [
      momentLocalizationResponse("source-1", [{ start: 4, end: 8 }]),
      JSON.stringify({ version: "1", operations: [] })
    ] });
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, hasMultipleVideos: false, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }));
    assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", ...expectedRange }]);
  }
});

test("visual moment localization confines explicit source scope and resolves semantic source scope first", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const explicitAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-2", [{ start: 5, end: 10 }]),
    JSON.stringify(fullSequence(catalog, ["source-1", "source-2"]))
  ] });
  const explicit = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 2, use the part where the person waves.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: explicitAi
  }));
  assert.deepEqual(explicit.plan.operations[0].clips, [{ sourceId: "source-2", start: 5, end: 10 }]);
  assert.equal(explicitAi.requests.length, 2);
  assert.equal(explicitAi.requests[0].contents[1].fileData.fileUri, explicitAi.uploads[1].uri);

  const semanticAi = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    momentLocalizationResponse("source-2", [{ start: 6, end: 11 }]),
    JSON.stringify(fullSequence(catalog, ["source-1", "source-2"]))
  ] });
  const semantic = await withGeminiKey(() => createAiEditPlan({
    prompt: "From the greenery clip, use the part where the path appears.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: semanticAi
  }));
  assert.deepEqual(semantic.plan.operations[0].clips, [{ sourceId: "source-2", start: 6, end: 11 }]);
  assert.equal(semanticAi.requests.length, 4);
  assert.equal(semanticAi.requests[2].contents[1].fileData.fileUri, semanticAi.uploads[1].uri);
});

test("unscoped visual moment requires exactly one candidate across all sources", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const uniqueAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", []),
    momentLocalizationResponse("source-2", [{ start: 2, end: 6 }]),
    JSON.stringify(fullSequence(catalog))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the bird takes off.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: uniqueAi
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 6 }]);
  assert.equal(uniqueAi.requests.length, 3);

  const templeAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", []),
    momentLocalizationResponse("source-2", [{ start: 2.1, end: 5.4 }]),
    JSON.stringify(fullSequence(catalog))
  ] });
  const templeResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person walks through the temple.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: templeAi
  }));
  assert.deepEqual(templeResult.plan.operations[0].clips, [{ sourceId: "source-2", start: 2.1, end: 5.4 }]);
  assert.equal(templeAi.requests.length, 3);

  for (const responses of [
    [momentLocalizationResponse("source-1", []), momentLocalizationResponse("source-2", [])],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 3 }]), momentLocalizationResponse("source-2", [{ start: 2, end: 4 }])],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 3 }, { start: 4, end: 6 }]), momentLocalizationResponse("source-2", [])]
  ]) {
    const aiClient = createMockGemini({ responses });
    await withGeminiKey(() => assert.rejects(
      () => createAiEditPlan({ prompt: "Use the part where the bird takes off.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
      /needs Gemini video understanding/
    ));
    assert.equal(aiClient.requests.length, 2);
  }
});

test("visual localization retries reuse the existing Gemini file and always cleans uploads", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const transient = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({
    failures: [transient, null, null],
    responses: [null, momentLocalizationResponse("source-1", [{ start: 2, end: 5 }]), JSON.stringify({ version: "1", operations: [] })]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the car enters.", hasMultipleVideos: false, sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(result.plan.version, "2");
  assert.equal(aiClient.uploads.length, 1);
  assert.equal(aiClient.requests.length, 3);
  assert.equal(aiClient.requests[0].contents[1].fileData.fileUri, aiClient.requests[1].contents[1].fileData.fileUri);
  assert.deepEqual(aiClient.deletes, ["files/1"]);
});

test("semantic multi-source planning classifies each Gemini video independently before planning", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-2", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Put the homestay video first, then the greenery video.", hasMultipleVideos: true,
    sourceCatalog, sourceInputs: plannerSources(), aiClient, retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(result.source, "gemini");
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.equal(aiClient.uploads.length, 3);
  assert.equal(aiClient.deletes.length, 3);
  for (const [index, source] of sourceCatalog.entries()) {
    const request = aiClient.requests[index];
    assert.equal(request.contents.filter((part) => part?.fileData).length, 1);
    assert.match(request.contents[0], new RegExp(`SOURCE ${source.sourceId}`));
    assert.equal(request.contents[1].fileData.fileUri, aiClient.uploads[index].uri);
  }
  assert.equal(aiClient.requests[3].contents.filter((part) => part?.fileData).length, 3);
  assert.match(aiClient.requests[3].contents.at(-1), /Authoritative resolved semantic sources/);
});

test("ambiguous semantic sources reject safely without calling the final planner", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }])
  ] });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.deletes.length, 2);
});

test("no-match semantic sources reject safely without calling the final planner", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }])
  ] });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: "Use the beach clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.deletes.length, 2);
});

test("semantic source classification rejects malformed evidence", () => {
  const references = [{ referenceId: "semantic-1", description: "greenery clip" }];
  const valid = { sourceId: "source-2", matches: [{ referenceId: "semantic-1", plausibleMatch: false }] };
  const cases = [
    [],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-2", matches: [] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }, { expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-1", plausibleMatch: false }] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-2", plausibleMatch: true }] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: "true" }] } }, { expectedSourceId: "source-2", response: valid }]
  ];
  for (const classifications of cases) {
    assert.throws(() => resolveSemanticSourceClassifications(classifications, references, sourceCatalog.slice(0, 2)), /needs Gemini video understanding/);
  }
});

test("mixed explicit and semantic references classify only the semantic reference and preserve V2 order", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use video 2 first, then the greenery clip.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 4);
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog }));
});

test("three-source semantic ordering remains valid after unique independent classification", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: false }, { referenceId: "semantic-3", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: true }, { referenceId: "semantic-3", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-2", plausibleMatch: false }, { referenceId: "semantic-3", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-3", "source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Start with the road footage, then the talking clip, then the greenery footage.", hasMultipleVideos: true,
    sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-3", "source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog }));
});

test("transient planning retries reuse uploaded Gemini files", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({
    failures: [null, error, null, null],
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      null,
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      JSON.stringify(fullSequence(catalog, ["source-2"]))
    ]
  });
  await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(aiClient.uploads.length, 2);
  assert.equal(aiClient.requests.length, 4);
  assert.equal(aiClient.deletes.length, 2);
  assert.equal(aiClient.requests[1].contents[1].fileData.fileUri, aiClient.requests[2].contents[1].fileData.fileUri);
});

test("retry exhaustion still cleans every uploaded Gemini file", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({
    failures: [null, error, error, error],
    responses: [classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }])]
  });
  await withGeminiKey(async () => {
    await assert.rejects(
      () => createAiEditPlan({
        prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
        retryOptions: { sleepFn: async () => {}, random: () => 0 }
      }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(aiClient.uploads.length, 2);
  assert.equal(aiClient.requests.length, 4);
  assert.equal(aiClient.deletes.length, 2);
});

test("malformed classification responses reject safely and clean uploaded Gemini files", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responseText: "not-json" });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({
      prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 1);
  assert.equal(aiClient.deletes.length, 2);
});

test("final planner failure after classification still cleans uploaded Gemini files", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({
    failures: [null, null, error, error, error],
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }])
    ]
  });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({
      prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
      retryOptions: { sleepFn: async () => {}, random: () => 0 }
    }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 5);
  assert.equal(aiClient.deletes.length, 2);
});

test("explicit-only requests do not invoke semantic selection", async () => {
  const aiClient = createMockGemini({ responseText: JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"])) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use video 2, then video 1.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 1);
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
});

test("explicit source-only color grading does not invoke semantic selection", async () => {
  const plan = fullSequence(sourceCatalog);
  plan.operations.push({ type: "color_grade", sourceId: "source-2", style: "bw" });
  const aiClient = createMockGemini({ responseText: JSON.stringify(plan) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make only video 2 black and white.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 1);
  assert.deepEqual(result.plan.operations[1], { type: "color_grade", sourceId: "source-2", style: "bw" });
});

test("explicit source-only color grading does not require visual understanding and falls back safely", async () => {
  const prompt = "Make only video 2 black and white.";
  assert.equal(requiresVisualSourceUnderstanding(prompt, sourceCatalog), false);

  const unavailable = await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    return createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() });
  });
  assert.equal(unavailable.source, "deterministic");
  assert.deepEqual(unavailable.plan, createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog }));
  assert.doesNotThrow(() => validateEditPlan(unavailable.plan, { sourceCatalog }));

  const transientFailure = Object.assign(new Error("high demand"), { status: 503 });
  const transient = await withGeminiKey(() => createAiEditPlan({
    prompt, hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(),
    aiClient: createMockGemini({ failures: [transientFailure, transientFailure, transientFailure] }),
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(transient.source, "deterministic");
  assert.deepEqual(transient.plan, unavailable.plan);
});

test("Gemini-unavailable explicit source requests retain fallback while semantic requests fail safely", async () => {
  const explicit = await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    return createAiEditPlan({ prompt: "Use video 2 then video 1.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() });
  });
  assert.equal(explicit.source, "deterministic");
  await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(
      () => createAiEditPlan({ prompt: "Use the beach clip first.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(requiresVisualSourceUnderstanding("Use the talking clip first, then the greenery footage.", sourceCatalog), true);
  assert.equal(requiresVisualSourceUnderstanding("Use video 2 first, then the greenery clip.", sourceCatalog), true);
});

test("multi-moment composition extraction is ordered, bounded, and preserves existing paired boundaries", () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  for (const { prompt, count } of [
    { prompt: "Use the part where the person enters, then the part where the person exits.", count: 2 },
    { prompt: "Use the part where the food is prepared and then the section where the food is served followed by the moment where the food is tasted.", count: 3 }
  ]) {
    const composition = extractMomentCompositionRequests(prompt, catalog);
    assert.equal(composition.requests.length, count);
    assert.deepEqual(composition.requests.map((request) => request.momentId), Array.from({ length: count }, (_, index) => `moment-${index + 1}`));
    assert.ok(composition.requests.every((request) => request.mode === "EVENT_SEGMENT"));
  }
  assert.equal(extractMomentCompositionRequests("Start when the door opens and end when she leaves.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when I begin talking about pricing and end when I begin talking about integrations.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when the door opens then end when she leaves.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when I begin talking about pricing then stop when I begin talking about integrations.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Use the part where the person walks and then rides a bicycle.", catalog), null);
  assert.equal(requiresMomentCompositionUnderstanding("Use the part where the person enters, then the part where the person exits.", catalog), true);
  assert.equal(requiresMomentCompositionUnderstanding("Start when the door opens and end when she leaves.", catalog), false);
  assert.equal(extractMomentCompositionRequests("Use the part where the door opens, then the part where.", catalog).error, "COMPOSITION_UNSUPPORTED_MOMENT");
  assert.equal(extractMomentCompositionRequests("Use the part where one, then the part where two, then the part where three, then the part where four, then the part where five, then the part where six.", catalog).error, "COMPOSITION_TOO_MANY_MOMENTS");
  assert.equal(extractMomentCompositionRequests("From the indoor clip, use the part where the person waves, then the part where the person leaves.", catalog).error, "COMPOSITION_SEMANTIC_SOURCE_SCOPE_UNSUPPORTED");

  const five = extractMomentCompositionRequests("Use the part where one, then the part where two, then the part where three, then the part where four, then the part where five.", catalog);
  assert.deepEqual(five.requests.map((request) => request.momentId), ["moment-1", "moment-2", "moment-3", "moment-4", "moment-5"]);

  const quotedComposition = extractMomentCompositionRequests('Use the part where I say "one and make two", then the part where I say "done".', catalog);
  assert.deepEqual(quotedComposition.requests.map((request) => request.startPhrase), ["one and make two", "done"]);
  const quotedThen = extractMomentCompositionRequests('Use the part where I say "first then second", then the part where I say "done".', catalog);
  assert.deepEqual(quotedThen.requests.map((request) => request.startPhrase), ["first then second", "done"]);
  const curly = extractMomentCompositionRequests("Use the part where I say “one and make two”, then the part where I say “done”.", catalog);
  assert.deepEqual(curly.requests.map((request) => request.startPhrase), ["one and make two", "done"]);
  assert.equal(extractMomentCompositionRequests('Use the part where I say "first then the part where second".', catalog), null);
  assert.equal(extractSpokenMomentRequest('Use the part where I say "first then the part where second".', catalog).startPhrase, "first then the part where second");
  assert.equal(extractMomentCompositionRequests("Use the part where one,then the part where two.", catalog).requests.length, 2);
});

test("multi-moment visual composition preserves requested order and replaces final planner clips", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 8, end: 10 }], "moment-1"),
    momentLocalizationResponse("source-1", [{ start: 2, end: 4 }], "moment-2"),
    JSON.stringify(fullSequence(catalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where the person enters, then from video 1, use the part where the person exits.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan.operations[0], {
    type: "sequence",
    clips: [{ sourceId: "source-1", start: 8, end: 10 }, { sourceId: "source-1", start: 2, end: 4 }]
  });
  assert.equal(aiClient.requests.length, 3);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog: catalog }));
});

test("multi-moment composition searches each unscoped request independently and builds three clips", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"),
    momentLocalizationResponse("source-2", [], "moment-1"),
    momentLocalizationResponse("source-1", [], "moment-2"),
    momentLocalizationResponse("source-2", [{ start: 4, end: 6 }], "moment-2"),
    momentLocalizationResponse("source-1", [{ start: 7, end: 9 }], "moment-3"),
    momentLocalizationResponse("source-2", [], "moment-3"),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the door opens, then the part where the person enters, followed by the part where the door closes.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan.operations[0].clips, [
    { sourceId: "source-1", start: 1, end: 2 },
    { sourceId: "source-2", start: 4, end: 6 },
    { sourceId: "source-1", start: 7, end: 9 }
  ]);
  assert.equal(aiClient.requests.length, 7);
});

test("multi-moment composition routes visual and exact spoken clauses independently and reuses transcripts", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 5 }], "moment-1"),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })
  ], transcriptionInteractions: [interaction([
    { text: "Welcome", start_offset: "7s", end_offset: "7.3s" },
    { text: "Back.", start_offset: "7.3s", end_offset: "7.7s" }
  ])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'From video 1, use the part where the person waves, then from video 2, use the part where I say "Welcome Back" and make it black and white.',
    hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 5 }, { sourceId: "source-2", start: 7, end: 7.7 }] },
    { type: "color_grade", style: "bw" }
  ]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(aiClient.requests.length, 2);
  assert.match(aiClient.requests[0].contents.at(-1), /person waves/);
});

test("multi-moment exact and semantic speech reuse one source transcript", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-2" }], "moment-1"),
    JSON.stringify({ version: "1", operations: [] })
  ], transcriptionInteractions: [interaction([
    { text: "Welcome", start_offset: "1s", end_offset: "1.4s" },
    { text: "Pricing.", start_offset: "2.5s", end_offset: "3s" }
  ])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I explain pricing, then the part where I say "Welcome".', sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 2.5, end: 3 }, { sourceId: "source-1", start: 1, end: 1.4 }]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(aiClient.requests.length, 2);
});

test("multi-moment composition rejects atomically when any clause has zero or ambiguous candidates", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  for (const responses of [
    [momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"), momentLocalizationResponse("source-2", [], "moment-2")],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"), momentLocalizationResponse("source-2", [{ start: 3, end: 4 }, { start: 5, end: 6 }], "moment-2")]
  ]) {
    const aiClient = createMockGemini({ responses });
    await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
      prompt: "From video 1, use the part where the person enters, then from video 2, use the part where the person exits.", hasMultipleVideos: true,
      sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }), UnsupportedEditRequestError));
    assert.equal(aiClient.requests.length, 2);
  }
});

test("multi-moment malformed composition rejects before any localization or final plan", async () => {
  const aiClient = createMockGemini();
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Use the part where the person enters, then the part where.", hasMultipleVideos: true,
    sourceCatalog: sourceCatalog.slice(0, 2), sourceInputs: plannerSources(sourceCatalog.slice(0, 2)), aiClient
  }), UnsupportedEditRequestError));
  assert.equal(aiClient.requests.length, 0);
  assert.equal(aiClient.uploads.length, 0);
});

test("multi-moment explicit scopes isolate visual and semantic speech work", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 4, end: 6 }], "moment-1"),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }], "moment-2"),
    JSON.stringify({ version: "1", operations: [] })
  ], transcriptionInteractions: [interaction([{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where the person waves, then from video 2, use the part where I explain pricing.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 4, end: 6 }, { sourceId: "source-2", start: 2, end: 2.5 }]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.match(aiClient.requests[0].contents[0], /SOURCE source-1/);
  assert.match(aiClient.requests[1].contents, /source-2-seg-1/);
});

test("multi-source compositions reject final planner source-scoped operations but retain global operations", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const prompt = "From video 1, use the part where the person enters, then from video 2, use the part where the person exits and make it black and white.";
  const localizationResponses = [
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }], "moment-1"),
    momentLocalizationResponse("source-2", [{ start: 4, end: 6 }], "moment-2")
  ];
  const scoped = createMockGemini({ responses: [...localizationResponses, JSON.stringify({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 30 }] },
    { type: "color_grade", sourceId: "source-1", style: "bw" }
  ] })] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: scoped }), UnsupportedEditRequestError));

  const global = createMockGemini({ responses: [...localizationResponses, JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: global }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }, { sourceId: "source-2", start: 4, end: 6 }] },
    { type: "color_grade", style: "bw" }
  ]);
});

async function makeMixedFrameRateSource(output, frameRate, duration) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=${frameRate}`,
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", duration.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
  ]);
}

async function makeSolidCaptionSource(output, duration, { width = 1280, height = 720 } = {}) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:size=${width}x${height}:rate=30`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", duration.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
  ]);
}

async function captionRegionDifference(videoPath, firstTime, secondTime) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", firstTime.toString(), "-i", videoPath,
    "-ss", secondTime.toString(), "-i", videoPath,
    "-filter_complex", "[0:v][1:v]blend=all_mode=difference,crop=768:216:256:468",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  return [...stdout].reduce((sum, value) => sum + value, 0);
}

async function executeWithWatchdog(options, { watchdogMs = 8_000 } = {}) {
  const executionController = createExecutionController({ gracePeriodMs: 500 });
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    executionController.cancel();
  }, watchdogMs);
  try {
    const output = await executeEditPlan({ ...options, executionController });
    assert.equal(watchdogFired, false, "mixed-FPS watchdog fired");
    return output;
  } finally {
    clearTimeout(watchdog);
    executionController.dispose();
  }
}

async function probeRenderedVideo(outputPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate,time_base,nb_frames", "-of", "json", outputPath
  ]);
  const probe = JSON.parse(stdout);
  return {
    duration: Number(probe.format.duration),
    video: probe.streams.find((stream) => stream.codec_type === "video"),
    audio: probe.streams.find((stream) => stream.codec_type === "audio")
  };
}

test("mixed 24fps and 30fps sequence concat preserves a bounded VFR output", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-mixed-fps-"));
  const sourcePaths = [path.join(tempDirectory, "source-24.mp4"), path.join(tempDirectory, "source-30.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 4);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 10);
    const media = [
      { duration: 4, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 10, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const startedAt = Date.now();
    const renderedPath = await executeWithWatchdog({
      inputPaths: sourcePaths,
      media,
      sourceCatalog: catalog,
      tempDirectory,
      plan: {
        version: "2",
        operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 4 }, { sourceId: "source-2", start: 0, end: 10 }] }]
      }
    });
    assert.equal(renderedPath, path.join(tempDirectory, "sequence.mp4"));
    assert.ok(Date.now() - startedAt < 10_000, "mixed-FPS render should complete quickly");
    const outputStats = await stat(renderedPath);
    assert.ok(outputStats.size > 0 && outputStats.size < 5 * 1024 * 1024, "output should remain bounded");
    const { duration, video, audio } = await probeRenderedVideo(renderedPath);
    assert.ok(duration > 13.8 && duration < 14.3, `unexpected output duration: ${duration}`);
    assert.ok(video, "output should include video");
    assert.ok(audio, "output should include audio");
    assert.ok(Number(video.nb_frames) > 350 && Number(video.nb_frames) < 600, `unexpected video frame count: ${video.nb_frames}`);
    const [numerator, denominator] = video.avg_frame_rate.split("/").map(Number);
    assert.ok(Number.isFinite(numerator / denominator) && numerator / denominator > 0 && numerator / denominator < 100, `unexpected video frame rate: ${video.avg_frame_rate}`);
    assert.match(video.time_base, /^\d+\/\d+$/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("mixed-FPS sequence remains playable through global black and white", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-mixed-fps-color-"));
  const sourcePaths = [path.join(tempDirectory, "source-24.mp4"), path.join(tempDirectory, "source-30.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 1);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 1);
    const media = [
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const renderedPath = await executeWithWatchdog({
      inputPaths: sourcePaths,
      media,
      sourceCatalog: catalog,
      tempDirectory,
      plan: {
        version: "2",
        operations: [
          { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }, { sourceId: "source-2", start: 0, end: 1 }] },
          // Compatibility only: downstream filters may choose their own output cadence.
          { type: "color_grade", style: "bw" }
        ]
      }
    });
    const outputStats = await stat(renderedPath);
    const { duration, video, audio } = await probeRenderedVideo(renderedPath);
    assert.ok(outputStats.size > 0 && outputStats.size < 2 * 1024 * 1024, "processed output should remain bounded");
    assert.ok(duration > 1.8 && duration < 2.2, `unexpected processed duration: ${duration}`);
    assert.ok(video && audio, "processed output should retain video and audio");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

function titlePlan(operation, { version = "1" } = {}) {
  return { version, operations: [operation] };
}

test("title typography normalizes legacy and rich title plans through the registered catalog", () => {
  const legacy = titlePlan({
    type: "title", text: "Trip to Kerala", start: 0, end: 3,
    position: "bottom", size: "medium", color: "white", weight: "regular", font: "instrumentSerif"
  });
  validateEditPlan(legacy);
  assert.equal(legacy.operations[0].position, "bottom-center");
  assert.equal(legacy.operations[0].font, "instrumentSerif");
  assert.deepEqual(legacy.operations[0].runs, [{ text: "Trip to Kerala", font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" }]);

  const rich = titlePlan({
    type: "title", text: "Trip to Kerala", start: 0.25, end: 3,
    position: "bottom-right", size: "medium", color: "white", weight: "regular", font: "inter",
    runs: [
      { text: "Trip to ", font: "inter", size: "medium", color: "#FFFFFF", weight: "regular" },
      { text: "Kerala", fontIntent: "elegant classy", size: 58, color: "#677dec", weight: "bold" }
    ]
  });
  validateEditPlan(rich);
  assert.deepEqual(rich.operations[0].runs[1], { text: "Kerala", font: "instrumentSerif", size: 58, color: "#677DEC", weight: "bold" });
  assert.equal(resolveFontId("Instrument Serif"), "instrumentSerif");
  assert.equal(resolveFontId("Comic Sans"), null);
  assert.equal(resolveSemanticFontIntent("gaming fun"), "jetbrainsMono");
  assert.ok(Object.values(FONT_CATALOG).every((font) => font.files.regular));
  assert.match(buildAiEditorPrompt({ prompt: "Add a title", sourceCatalog: [] }), /Title timestamps use the final assembled output timeline/);
  assert.deepEqual(parseTitle('Add the title "Kerala" at 0:03 in a large font.'), {
    text: '"Kerala"', start: 3, end: 6, position: "center", size: "large", color: "white", weight: "regular", font: "inter"
  });
  assert.equal(parseTitle('Add the title "Kerala" using Comic Sans font.').font, "__unavailable__");
});

test("title typography rejects unsupported renderer values and inconsistent rich runs", () => {
  const base = { type: "title", text: "Kerala", start: 0, end: 1, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
  for (const operation of [
    { ...base, color: "#12FG00" },
    { ...base, font: "Comic Sans" },
    { ...base, size: 999 },
    { ...base, position: "middle-ish" },
    { ...base, start: 2, end: 1 },
    { ...base, runs: [{ text: "Different" }] }
  ]) {
    assert.throws(() => validateEditPlan(titlePlan(operation)), /Invalid edit plan/);
  }
});

test("ASS title rendering escapes control-like text while preserving Unicode and independent runs", () => {
  const document = buildAssDocument([{
    text: "Hello ｛world｝ Kerala",
    start: 0.25, end: 1.75, position: "top-left",
    runs: [
      { text: "Hello {\\pos(1,1)} ", font: "inter", size: 32, color: "#FFFFFF", weight: "regular" },
      { text: "കേരള", font: "instrumentSerif", size: 44, color: "#45A049", weight: "bold" }
    ]
  }], { width: 640, height: 360 });
  assert.match(document, /Dialogue: 0,0:00:00\.25,0:00:01\.75/);
  assert.match(document, /\\fnInter\\fs32\\c&H00FFFFFF&\\b0/);
  assert.match(document, /\\fnInstrument Serif\\fs44\\c&H0049A045&\\b1/);
  assert.match(document, /｛＼pos\(1,1\)｝/);
  assert.match(document, /കേരള/);
  assert.doesNotMatch(document, /\}\{\\pos\(1,1\)/);
});

test("rich ASS titles render after a sequence and temporal trim on the final output timeline", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-title-render-"));
  const sourcePaths = [path.join(tempDirectory, "one.mp4"), path.join(tempDirectory, "two.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 1);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 1);
    const media = [
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const plan = {
      version: "2",
      operations: [
        { type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 1 }, { sourceId: "source-1", start: 0, end: 1 }] },
        { type: "trim", start: 0.25, end: 1.75 },
        {
          type: "title", text: "Trip to Kerala", start: 0.25, end: 1.1,
          position: "bottom-right", size: "medium", color: "white", weight: "regular", font: "inter",
          runs: [
            { text: "Trip to ", font: "inter", size: 24, color: "#FFFFFF", weight: "regular" },
            { text: "Kerala", font: "instrumentSerif", size: 36, color: "#45A049", weight: "bold" }
          ]
        }
      ]
    };
    validateEditPlan(plan, { sourceCatalog: catalog });
    const output = await executeWithWatchdog({ inputPaths: sourcePaths, media, sourceCatalog: catalog, tempDirectory, plan }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    const { duration, video, audio } = await probeRenderedVideo(output);
    assert.match(ass, /Dialogue: 0,0:00:00\.25,0:00:01\.10/);
    assert.match(ass, /\\fnInter/);
    assert.match(ass, /\\fnInstrument Serif/);
    assert.ok(duration > 1.35 && duration < 1.65, `unexpected title render duration: ${duration}`);
    assert.ok(video && audio, "rich title output should remain playable with audio");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("captions segment canonical transcript words into readable server-owned cues", () => {
  const cues = createCaptionCues(createCanonicalTranscript({ sourceId: "source-1", duration: 10, words: [
    { text: "Welcome", start: 0, end: 0.3 }, { text: "to", start: 0.3, end: 0.45 }, { text: "Kerala.", start: 0.45, end: 0.9 },
    { text: "This", start: 2, end: 2.2 }, { text: "is", start: 2.2, end: 2.35 }, { text: "Cliponaut.", start: 2.35, end: 2.9 }
  ] }));
  assert.deepEqual(cues, [
    { sourceId: "source-1", text: "Welcome to Kerala.", start: 0, end: 0.9 },
    { sourceId: "source-1", text: "This is Cliponaut.", start: 2, end: 2.9 }
  ]);
  assert.deepEqual(createCaptionCues({ sourceId: "source-2", segments: [] }), []);
});

test("caption timing maps source cues through repeated V2 clips, trim, and speed", () => {
  const catalog = [{ sourceId: "source-1", index: 0, duration: 10, hasAudio: true }];
  const cues = [{ sourceId: "source-1", text: "Hello", start: 2, end: 4 }];
  const repeated = { version: "2", operations: [{ type: "sequence", clips: [
    { sourceId: "source-1", start: 0, end: 5 }, { sourceId: "source-1", start: 1, end: 5 }
  ] }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, repeated, catalog), [
    { text: "Hello", start: 2, end: 4 }, { text: "Hello", start: 6, end: 8 }
  ]);
  const temporal = { version: "2", operations: [...repeated.operations, { type: "trim", start: 1, end: 7 }, { type: "speed", factor: 2 }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, temporal, catalog), [
    { text: "Hello", start: 0.5, end: 1.5 }, { text: "Hello", start: 2.5, end: 3 }
  ]);
  const ranged = { version: "1", operations: [{ type: "speed", start: 1, end: 3, factor: 2 }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, ranged, catalog), [
    { text: "Hello", start: 1.5, end: 2 }, { text: "Hello", start: 2, end: 3 }
  ]);
});

test("caption corrections preserve timings and reject unsafe no-match or ambiguous replacements", () => {
  const cues = [
    { text: "I am the founder of clip or not", start: 6.5, end: 7.5 },
    { text: "Clip or not helps editors", start: 8, end: 9 }
  ];
  const corrected = applyCaptionCorrection(cues, { from: "I am the founder of Cliponaut", to: "I am the founder of Cliponaut", scope: "one", at: 7 });
  assert.equal(corrected[0].text, "I am the founder of Cliponaut");
  assert.deepEqual(corrected.map(({ start, end }) => ({ start, end })), cues.map(({ start, end }) => ({ start, end })));
  const everywhere = applyCaptionCorrection(cues, { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.deepEqual(everywhere.map((cue) => cue.text), ["I am the founder of Cliponaut", "Cliponaut helps editors"]);
  assert.throws(() => applyCaptionCorrection(cues, { from: "clip or not", to: "Cliponaut", scope: "one" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_AMBIGUOUS");
  assert.throws(() => applyCaptionCorrection(cues, { from: "missing", to: "new", scope: "one" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_NO_MATCH");
  assert.throws(() => applyCaptionCorrection(cues, { from: "missing", to: "new", scope: "all" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_NO_MATCH");
  assert.deepEqual(extractCaptionCorrection('Change "clip or not" everywhere to "Cliponaut" in the video.'), { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.deepEqual(extractCaptionCorrection("Change clip or not everywhere to Cliponaut in the video"), { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.equal(requestsCaptions("Change clip or not everywhere to Cliponaut in the video"), true);
  assert.equal(requestsCaptions('Change "clip or not" everywhere to "Cliponaut" in the video.'), true);
});

test("caption correction parsing supports targeted subtitle and sentence wording", () => {
  const expected = { from: "I am the founder of clip or not", to: "I am the founder of Cliponaut", scope: "one", at: 7 };
  assert.deepEqual(extractCaptionCorrection("Change the subtitle or sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection('Change the subtitle "I am the founder of clip or not" to "I am the founder of Cliponaut" at 0:07'), expected);
  assert.deepEqual(extractCaptionCorrection("Change the sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection("Change the subtitle 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection("Change the subtitle or sentence ‘I am the founder of clip or not’ to ‘I am the founder of Cliponaut’ at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection('Change the sentence “I am the founder of clip or not” to “I am the founder of Cliponaut” at 0:07'), expected);
  assert.equal(requestsCaptions("Change the sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), true);
});

test("caption intent reconciliation preserves explicit prompt styling after Gemini planning", async () => {
  const prompt = "Add subtitles using Inter, #677DEC, larger text at the bottom center";
  const explicitStyle = { font: "inter", color: "#677DEC", size: "large", position: "bottom-center" };
  assert.deepEqual(extractCaptionStyleRequest(prompt), explicitStyle);
  assert.deepEqual(createEditPlan({ prompt }).operations.find((operation) => operation.type === "captions"), { type: "captions", ...explicitStyle });
  assert.equal(createEditPlan({ prompt: "Add subtitles" }).operations.filter((operation) => operation.type === "captions").length, 1);
  assert.equal(createEditPlan({ prompt: 'Change the subtitle "old text" to "new text" at 0:07' }).operations.filter((operation) => operation.type === "captions").length, 1);

  const omitted = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }) });
  const omittedResult = await withGeminiKey(() => createAiEditPlan({
    prompt, sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: omitted
  }));
  assert.deepEqual(omittedResult.plan.operations, [{ type: "color_grade", style: "bw" }, { type: "captions", ...explicitStyle }]);

  const conflicting = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{
    type: "captions", font: "jetbrainsMono", fontIntent: "serif", color: "#E94B4B", size: "small", position: "top-left", weight: "bold"
  }] }) });
  const conflictResult = await withGeminiKey(() => createAiEditPlan({
    prompt, sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: conflicting
  }));
  assert.deepEqual(conflictResult.plan.operations, [{ type: "captions", ...explicitStyle, weight: "bold" }]);

  const unspecified = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{
    type: "captions", font: "instrumentSerif", color: "#F6D365", size: "small", position: "top-left", weight: "bold"
  }] }) });
  const unspecifiedResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Add subtitles", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: unspecified
  }));
  assert.deepEqual(unspecifiedResult.plan.operations, [{
    type: "captions", font: "instrumentSerif", color: "#F6D365", size: "small", position: "top-left", weight: "bold"
  }]);

  const nonCaption = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }) });
  const nonCaptionResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make the video black and white", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: nonCaption
  }));
  assert.equal(nonCaptionResult.plan.operations.some((operation) => operation.type === "captions"), false);
});

test("styled captions preserve dialogue events and render with server-owned final cues", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-render-"));
  const inputPath = path.join(tempDirectory, "source.mp4");
  try {
    await makeMixedFrameRateSource(inputPath, 30, 2);
    const media = [{ duration: 2, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
    const plan = { version: "1", operations: [
      { type: "title", text: "Existing title", start: 0.1, end: 0.5, position: "top-center", size: "small", color: "white", weight: "bold", font: "inter" },
      { type: "captions", font: "inter", position: "bottom-center", size: "large", color: "#677DEC", weight: "regular" }
    ] };
    validateEditPlan(plan);
    assert.deepEqual(plan.operations[1], { type: "captions", font: "inter", position: "bottom-center", size: "large", color: "#677DEC", weight: "regular" });
    assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "captions" }, { type: "captions" }] }), /only one captions/);
    const sourceCatalog = [{ sourceId: "source-1", index: 0, duration: 2, hasAudio: true }];
    const output = await executeWithWatchdog({ inputPaths: [inputPath], media, sourceCatalog, tempDirectory, plan, captionCues: [{ sourceId: "source-1", text: "കേരള {\\pos(1,1)}", start: 0.2, end: 1.2 }] });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.equal(ass.match(/^Dialogue: /gm)?.length, 2);
    assert.match(ass, /^Dialogue: /m);
    assert.match(ass, /\\an2\\pos\(80,76\)/);
    assert.match(ass, /\\fnInter\\fs9/);
    assert.match(ass, /കേരള ｛＼pos\(1,1\)｝/);
    assert.match(ass, /\\c&H00EC7D67&/);
    assert.ok((await stat(output)).size > 0);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test("default and production-styled captions visibly alter final pixels at local and production canvas sizes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-pixels-"));
  const sourceCatalog = [{ sourceId: "source-1", index: 0, duration: 4, hasAudio: true }];
  const cue = [{ sourceId: "source-1", text: "Cliponaut caption test", start: 1, end: 3 }];
  try {
    for (const { width, height } of [{ width: 1280, height: 720 }, { width: 854, height: 480 }]) {
      const inputPath = path.join(root, `source-${width}x${height}.mp4`);
      const media = [{ duration: 4, width, height, hasAudio: true, frameRate: 30 }];
      await makeSolidCaptionSource(inputPath, 4, { width, height });
      for (const [name, operation] of [
        ["default", { type: "captions", font: "inter", color: "#FFFFFF", size: "medium", position: "bottom-center", weight: "regular" }],
        ["styled", { type: "captions", font: "inter", color: "#677DEC", size: "large", position: "bottom-center", weight: "regular" }]
      ]) {
        const tempDirectory = path.join(root, `${width}x${height}-${name}`);
        await mkdir(tempDirectory);
        const output = await executeWithWatchdog({
          inputPaths: [inputPath], media, sourceCatalog, tempDirectory,
          plan: { version: "1", operations: [operation] }, captionCues: cue
        }, { watchdogMs: 20_000 });
        const duringDifference = await captionRegionDifference(output, 0.5, 2);
        const outsideCueDifference = await captionRegionDifference(output, 0.5, 3.5);
        assert.ok(duringDifference > 50_000, `${width}x${height} ${name} caption should visibly alter the bottom-center region`);
        assert.ok(outsideCueDifference < 5_000, `${width}x${height} ${name} caption should not alter the region outside its cue window`);
        if (name === "styled") {
          const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
          assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.00/);
          assert.match(ass, new RegExp(`\\\\fnInter\\\\fs${Math.round(height * 0.1)}\\\\c&H00EC7D67&`));
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executor renders global-speed captions on the final output timeline", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-speed-"));
  const inputPath = path.join(tempDirectory, "source.mp4");
  try {
    await makeMixedFrameRateSource(inputPath, 30, 15);
    const media = [{ duration: 15, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
    const catalog = [{ sourceId: "source-1", index: 0, duration: 15, hasAudio: true }];
    const plan = { version: "1", operations: [{ type: "speed", factor: 1.5 }, { type: "captions" }] };
    validateEditPlan(plan, { sourceCatalog: catalog });
    const output = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory, plan,
      captionCues: [{ sourceId: "source-1", text: "Caption at ten seconds", start: 10, end: 11 }]
    }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(ass, /Dialogue: 0,0:00:06\.67,0:00:07\.33/);
    assert.ok((await probeRenderedVideo(output)).duration > 9.9 && (await probeRenderedVideo(output)).duration < 10.1);
    const trimPlan = { version: "1", operations: [{ type: "trim", start: 5, end: 15 }, { type: "captions" }] };
    validateEditPlan(trimPlan, { sourceCatalog: catalog });
    const trimmed = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory, plan: trimPlan,
      captionCues: [{ sourceId: "source-1", text: "Caption at ten seconds", start: 10, end: 11 }]
    }, { watchdogMs: 15_000 });
    const trimAss = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(trimAss, /Dialogue: 0,0:00:05\.00,0:00:06\.00/);
    assert.ok((await probeRenderedVideo(trimmed)).duration > 9.9 && (await probeRenderedVideo(trimmed)).duration < 10.1);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test("spoken selection retains its job-local transcript for caption reuse", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responses: [JSON.stringify({ version: "1", operations: [{ type: "captions" }] })],
    transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.4s" }])]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome" and add subtitles.', sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(result.transcripts.get("source-1").segments[0].text, "Welcome");
  assert.ok(result.plan.operations.some((operation) => operation.type === "captions"));
});

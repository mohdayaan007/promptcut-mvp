import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MAX_DIRECT_UPLOAD_FILE_BYTES, JOB_STATUSES, validateJobRequest, validateUploadManifest } from "@/lib/jobs/job-config";
import { buildNormalizationFilter, createMediaProfile } from "@/lib/editor-core/media-profile";
import { DIRECT_UPLOAD_CORS } from "@/lib/jobs/storage";
import { safeSourceMetadata } from "@/lib/jobs/http";
import { ACTIVE_JOB_STATUSES, isActiveJobStatus, isRecoverableJobStatus } from "@/lib/client/direct-upload";
import { EDIT_JOBS_SCHEMA } from "@/lib/jobs/job-store";
import { createEditPlan, extractSemanticSourceReferences, extractSpokenMomentRequest, extractVisualMomentRequest, requiresSpokenMomentUnderstanding, requiresVisualMomentUnderstanding, requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { createEditPlanJsonSchema, createSemanticSourceClassificationJsonSchema, createSemanticTranscriptMatchJsonSchema, createVisualMomentLocalizationJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { createAiEditPlan, resolveSemanticSourceClassifications, resolveVisualMomentLocalizations, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import { buildAiEditorPrompt, buildSemanticTranscriptMatchPrompt, buildVisualMomentLocalizationPrompt } from "@/lib/editor-core/ai-editor/prompt";
import { createExecutionController, EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";
import { TranscriptValidationError, createCanonicalTranscript, findPhraseOccurrences, normalizePhrase, pairPhraseOccurrences, validateTranscriptWords } from "@/lib/editor-core/spoken-transcript";
import { extractSpeechAudio, transcribeSource, wordAnnotations, SpokenTranscriptionError } from "@/lib/editor-core/spoken-transcription";

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

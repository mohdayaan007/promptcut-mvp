import { spawn as nodeSpawn } from "child_process";
import { rm as removeFile } from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { createCanonicalTranscript, TranscriptValidationError } from "@/lib/editor-core/spoken-transcript";
import { EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
const MAX_RETRIES = 2;

export class SpokenTranscriptionError extends Error {
  constructor(reason, cause) { super(reason); this.name = "SpokenTranscriptionError"; this.reason = reason; this.cause = cause; }
}

function transient(error) {
  const status = Number(error?.status || error?.statusCode || error?.code || error?.$metadata?.httpStatusCode);
  return status === 429 || status === 503 || status >= 500 && status < 600;
}

function seconds(value) {
  if (typeof value === "number") return value;
  const match = typeof value === "string" && value.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Number(match[1]) : NaN;
}

export function wordAnnotations(interaction = {}) {
  const annotations = (interaction.steps || []).flatMap((step) => (step.content || []).flatMap((content) => content.annotations || []));
  return annotations.filter((annotation) => annotation?.type === "word_info").map((annotation) => ({
    text: annotation.text,
    start: seconds(annotation.start_offset ?? annotation.startOffset),
    end: seconds(annotation.end_offset ?? annotation.endOffset)
  }));
}

export async function extractSpeechAudio({ inputPath, scratchDirectory, sourceId, executionController, spawn = nodeSpawn }) {
  const outputPath = path.join(scratchDirectory, `${sourceId}-speech.m4a`);
  executionController?.throwIfCancelled();
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", outputPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; let settled = false;
    const finish = (error) => { if (!settled) { settled = true; executionController?.detach(child); error ? reject(error) : resolve(); } };
    executionController?.attach(child);
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(executionController?.isCancelled() ? new EditExecutionCancelledError() : error));
    child.once("close", (code) => executionController?.isCancelled() ? finish(new EditExecutionCancelledError()) : code === 0 ? finish() : finish(new SpokenTranscriptionError("SPEECH_AUDIO_EXTRACTION_FAILED", new Error(stderr))));
  });
  return outputPath;
}

async function retryInteraction(ai, request, { sleep = () => Promise.resolve() } = {}) {
  let error;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try { return await ai.interactions.create(request); } catch (caught) {
      error = caught;
      if (!transient(caught) || attempt === MAX_RETRIES) throw new SpokenTranscriptionError(transient(caught) ? "SPEECH_TRANSCRIPTION_RETRIES_EXHAUSTED" : "SPEECH_TRANSCRIPTION_REQUEST_FAILED", caught);
      await sleep(300 * (2 ** attempt));
    }
  }
  throw error;
}

/** Creates one temporary, server-owned canonical transcript. Not wired to planner/worker in Stage 2. */
export async function transcribeSource({ inputPath, scratchDirectory, sourceId, duration, executionController, aiClient, spawn, sleep, remove = removeFile }) {
  let audioPath; let uploaded;
  const ai = aiClient || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    audioPath = await extractSpeechAudio({ inputPath, scratchDirectory, sourceId, executionController, spawn });
    uploaded = await ai.files.upload({ file: audioPath, config: { mimeType: "audio/m4a" } });
    const interaction = await retryInteraction(ai, { model: TRANSCRIBE_MODEL, input: [{ type: "audio", uri: uploaded.uri, mime_type: uploaded.mimeType || "audio/m4a" }], generation_config: { transcription_config: { mode: { type: "verbatim", timestamp_granularities: ["word"] } } } }, { sleep });
    try { return createCanonicalTranscript({ sourceId, duration, words: wordAnnotations(interaction) }); }
    catch (error) { throw new SpokenTranscriptionError(error instanceof TranscriptValidationError ? "SPEECH_INVALID_WORD_TIMESTAMPS" : "SPEECH_MALFORMED_TRANSCRIPT", error); }
  } finally {
    if (uploaded?.name) await ai.files.delete({ name: uploaded.name }).catch(() => {});
    if (audioPath) await remove(audioPath, { force: true }).catch(() => {});
  }
}

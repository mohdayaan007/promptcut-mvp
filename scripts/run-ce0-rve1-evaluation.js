#!/usr/bin/env node
/* CE-0 private evaluation. Refuses network activity unless --execute is explicit. */
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createCreativeEditingPlanJsonSchema } from "@/lib/editor-core/creative-editing-plan";
import { CE0_REFERENCE_DIAGNOSTIC_LIMITS, createPrivateEvaluationReport, loadSuccessfulReferenceAnalysis, runCreativeEvaluation, runReferenceDiagnostic } from "@/lib/editor-core/creative-evaluation-runner";
import { createEvaluationIdentity, createPrivateCheckpointStore } from "@/lib/editor-core/creative-evaluation-checkpoints";
import { wordAnnotations } from "@/lib/editor-core/spoken-transcription";
import { createCanonicalTranscript } from "@/lib/editor-core/spoken-transcript";

const root = "/private/tmp/cliponaut-ce0-rve1-preflight";
const referenceMedia = "/Users/ayaan/cliponaut-ce0-media/references/RVE1-Moved-to-Blore.mp4";
const sourceMedia = "/Users/ayaan/cliponaut-ce0-media/sources/RVE1/Cliponaut Team Video - Mohammed Ayaan.mp4";
const frameParts = async (directory) => Promise.all((await (await import("fs/promises")).readdir(directory)).sort().map(async (name) => ({ inlineData: { mimeType: "image/jpeg", data: (await readFile(path.join(directory, name))).toString("base64") } })));
const fileDigest = async (file) => crypto.createHash("sha256").update(await readFile(file)).digest("hex");
const run = (command, args) => new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed`))); });
async function main() {
 const args = new Set(process.argv.slice(2));
 if (!args.has("--execute")) { console.log(JSON.stringify({ status: "dry_run", required: ["--execute", "GEMINI_API_KEY"], calls: args.has("--reference-only") ? 1 : 5, retries: 0, budgetUsd: 0.10 })); return; }
 if (!process.env.GEMINI_API_KEY) throw new Error("CE-0 evaluation blocked: GEMINI_API_KEY is not configured");
 const scratch = await mkdtemp(path.join(os.tmpdir(), "cliponaut-ce0-"));
 const uploaded = [];
 let ai; let checkpointStore; let identity;
 try {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1, httpStatusCodes: [] } } });
  const reference = await frameParts(path.join(root, "reference-frames"));
  checkpointStore = createPrivateCheckpointStore(path.join(root, "checkpoints"));
  const referenceDiagnosticIdentity = createEvaluationIdentity({ referenceDigest: await fileDigest(referenceMedia), model: process.env.GEMINI_MODEL || "gemini-3.6-flash", schema: "reference-diagnostic/2", promptContract: "rve1-reference-diagnostic/2", limits: { flashInput: 25000, flashOutput: CE0_REFERENCE_DIAGNOSTIC_LIMITS.maxOutputTokens, dollars: CE0_REFERENCE_DIAGNOSTIC_LIMITS.dollars, thinkingLevel: "MINIMAL" } });
  const referenceDiagnosticFlash = async ({ maxOutputTokens }) => ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    contents: [{ role: "user", parts: [...reference, { text: "Analyze only these sampled reference frames. Return JSON with exactly six non-empty strings: typography, composition, pacing, colourDirection, effectiveness, limitations. Cover editorial/kinetic typography, font pairing and hierarchy; image/graphic composition; visible animation or pacing cues; colour direction; why choices are effective; and what sampled frames cannot establish. Do not infer audio, unobserved timing, or source footage." }] }],
    config: { responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { typography: { type: "string" }, composition: { type: "string" }, pacing: { type: "string" }, colourDirection: { type: "string" }, effectiveness: { type: "string" }, limitations: { type: "string" } }, required: ["typography", "composition", "pacing", "colourDirection", "effectiveness", "limitations"], additionalProperties: false }, maxOutputTokens, thinkingConfig: { thinkingLevel: "MINIMAL" } }
  });
  if (args.has("--reference-only")) {
    const diagnostic = await runReferenceDiagnostic({ flash: referenceDiagnosticFlash, request: {}, checkpointStore, evaluationIdentity: referenceDiagnosticIdentity });
    await writeFile(path.join(root, "ce0-reference-diagnostic.json"), JSON.stringify({ usage: diagnostic.usage, analysis: diagnostic.analysis, rawProviderResponsesRetained: false, providerUploadCleanup: "not_applicable_inline_frames_only" }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "completed", requestCount: diagnostic.usage.requestCount, report: "private reference diagnostic written" })); return;
  }
  const source = await frameParts(path.join(root, "source-frames"));
  const audio = path.join(scratch, "source.m4a");
  await run("ffmpeg", ["-y", "-v", "error", "-i", sourceMedia, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audio]);
  const sourceEvidence = source.flatMap((part, index) => [{ text: `Evidence ID source-frame-${index + 1}; an overview frame, not proof of a precise cut.` }, part]);
  const flash = async ({ phase, maxOutputTokens, transcript, priorOutputs }) => {
    const parts = phase === "reference" ? [...reference, { text: "Describe only the aesthetic: typography hierarchy, composition, pacing, color, and required external assets. Return compact JSON." }]
      : phase === "overview" ? [...sourceEvidence, { text: "Identify up to three source-local candidate windows for a 20-30 second founder reel. Return compact JSON with only supplied frame evidence IDs; preserve speech." }]
      : phase === "fine" ? [...sourceEvidence, { text: "Review candidate timing conservatively. Return compact JSON; do not invent precise words or cuts." }]
      : [{ text: JSON.stringify({ reference: priorOutputs[0], overview: priorOutputs[1], fine: priorOutputs[2], transcript, sourceEvidenceIds: Array.from({ length: 16 }, (_, index) => `source-frame-${index + 1}`), instruction: "Create a source-grounded creative/1 plan for a 20-30 second founder reel. Use requirements for unprovided graphics/images." }) }];
    return ai.models.generateContent({ model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", responseJsonSchema: phase === "plan" ? createCreativeEditingPlanJsonSchema() : { type: "object" }, maxOutputTokens } });
  };
  const transcribe = async () => {
    const file = await ai.files.upload({ file: audio, config: { mimeType: "audio/m4a" } }); uploaded.push(file);
    await checkpointStore.save({ identity, stage: "cleanup", status: "cleanup_pending", providerFileIds: [file.name], requestCount: 0, usage: {} });
    const response = await ai.interactions.create({ model: "gemini-3.5-transcribe", input: [{ type: "audio", uri: file.uri, mime_type: file.mimeType || "audio/m4a" }], generation_config: { transcription_config: { mode: { type: "verbatim", timestamp_granularities: ["word"] } } } });
    return { response, value: createCanonicalTranscript({ sourceId: "source-1", duration: 117.098089, words: wordAnnotations(response) }) };
  };
  identity = createEvaluationIdentity({ referenceDigest: await fileDigest(referenceMedia), sourceDigest: await fileDigest(sourceMedia), model: process.env.GEMINI_MODEL || "gemini-3.6-flash", schema: "creative/1", promptContract: "rve1-founder-reel/1", limits: { flashInput: 35000, flashOutput: 4800, dollars: 0.10 } });
  const importedReference = args.has("--reuse-reference") ? await loadSuccessfulReferenceAnalysis({ checkpointStore, evaluationIdentity: referenceDiagnosticIdentity }) : null;
  const requests = importedReference ? [{ phase: "overview" }, { phase: "fine" }, { phase: "plan" }] : [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }];
  const result = await runCreativeEvaluation({ flash, transcribe, requests, sourceCatalog: [{ sourceId: "source-1", duration: 117.098089 }], evidenceIds: Array.from({ length: 16 }, (_, index) => `source-frame-${index + 1}`), transcriptionSeconds: 116.992, checkpointStore, evaluationIdentity: identity, allowResume: args.has("--resume"), importedReference });
  await writeFile(path.join(root, "ce0-evaluation-report.json"), JSON.stringify(createPrivateEvaluationReport({ result }), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: "completed", requestCount: result.usage.requestCount, report: "private report written" }));
 } finally {
  const cleanup = await Promise.all(uploaded.map(async (file) => {
    if (!file?.name) return true;
    try { await ai?.files.delete({ name: file.name }); return true; } catch { return false; }
  }));
  if (checkpointStore && identity && uploaded.length) await checkpointStore.save({ identity, stage: "cleanup", status: cleanup.every(Boolean) ? "cleanup_succeeded" : "cleanup_failed", providerFileIds: uploaded.map((file) => file.name), requestCount: 0, usage: {} });
  await rm(scratch, { recursive: true, force: true });
}
}
main().catch((error) => { console.error("CE-0 evaluation stopped:", error.message); process.exitCode = 1; });

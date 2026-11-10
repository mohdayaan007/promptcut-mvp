#!/usr/bin/env node
/* CE-0 private evaluation. Refuses network activity unless --execute is explicit. */
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { createCreativeEditingPlanJsonSchema } from "@/lib/editor-core/creative-editing-plan";
import { createPrivateEvaluationReport, runCreativeEvaluation } from "@/lib/editor-core/creative-evaluation-runner";
import { wordAnnotations } from "@/lib/editor-core/spoken-transcription";
import { createCanonicalTranscript } from "@/lib/editor-core/spoken-transcript";

const root = "/private/tmp/cliponaut-ce0-rve1-preflight";
const frameParts = async (directory) => Promise.all((await (await import("fs/promises")).readdir(directory)).sort().map(async (name) => ({ inlineData: { mimeType: "image/jpeg", data: (await readFile(path.join(directory, name))).toString("base64") } })));
const run = (command, args) => new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed`))); });
async function main() {
 const args = new Set(process.argv.slice(2));
 if (!args.has("--execute")) { console.log(JSON.stringify({ status: "dry_run", required: ["--execute", "GEMINI_API_KEY"], calls: 5, retries: 0, budgetUsd: 0.10 })); return; }
 if (!process.env.GEMINI_API_KEY) throw new Error("CE-0 evaluation blocked: GEMINI_API_KEY is not configured");
 const scratch = await mkdtemp(path.join(os.tmpdir(), "cliponaut-ce0-"));
 const uploaded = [];
 let ai;
 try {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1, httpStatusCodes: [] } } });
  const reference = await frameParts(path.join(root, "reference-frames"));
  const source = await frameParts(path.join(root, "source-frames"));
  const audio = path.join(scratch, "source.m4a");
  await run("ffmpeg", ["-y", "-v", "error", "-i", "/Users/ayaan/cliponaut-ce0-media/sources/RVE1/Cliponaut Team Video - Mohammed Ayaan.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audio]);
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
    const response = await ai.interactions.create({ model: "gemini-3.5-transcribe", input: [{ type: "audio", uri: file.uri, mime_type: file.mimeType || "audio/m4a" }], generation_config: { transcription_config: { mode: { type: "verbatim", timestamp_granularities: ["word"] } } } });
    return createCanonicalTranscript({ sourceId: "source-1", duration: 117.098089, words: wordAnnotations(response) });
  };
  const result = await runCreativeEvaluation({ flash, transcribe, requests: [{ phase: "reference" }, { phase: "overview" }, { phase: "fine" }, { phase: "plan" }], sourceCatalog: [{ sourceId: "source-1", duration: 117.098089 }], evidenceIds: Array.from({ length: 16 }, (_, index) => `source-frame-${index + 1}`), transcriptionSeconds: 116.992 });
  await writeFile(path.join(root, "ce0-evaluation-report.json"), JSON.stringify(createPrivateEvaluationReport({ result }), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: "completed", requestCount: result.usage.requestCount, report: "private report written" }));
 } finally {
  await Promise.all(uploaded.map((file) => file?.name ? ai?.files.delete({ name: file.name }).catch(() => {}) : Promise.resolve()));
  await rm(scratch, { recursive: true, force: true });
}
}
main().catch((error) => { console.error("CE-0 evaluation stopped:", error.message); process.exitCode = 1; });

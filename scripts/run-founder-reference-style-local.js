/**
 * Starts an isolated, localhost-only founder Reference Style application.
 * It creates no cloud resources and never reads production configuration.
 * The caller supplies FOUNDER_TEST_ACCESS_CODE in their shell; it is inherited
 * by child processes but is never written to disk or printed.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideoFile } from "@/lib/media/media-probe";
import { createFounderStyleProfileFromObservations, FOUNDER_REFERENCE_STYLE_ASSETS, validateFounderReferenceStyleManifest } from "@/lib/editor-core/founder-reference-style-staging-contract";

const root = process.env.FOUNDER_REFERENCE_STYLE_LOCAL_ROOT || path.join(os.homedir(), ".cliponaut-founder-reference-style-local");
const port = Number(process.env.FOUNDER_REFERENCE_STYLE_LOCAL_PORT || 55432);
const appPort = Number(process.env.PORT || 3000);
const referencePath = "/Users/ayaan/Moved to Blore RVE1.mp4";
const sourcePath = "/Users/ayaan/Gym Outside Test.mp4";
const checkpointPath = "/Users/ayaan/cliponaut-founder-reference-style-analysis/validated-style-analysis.json";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio || "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed`)));
  });
}
function launch(command, args, env) {
  const child = spawn(command, args, { cwd: repository, env, stdio: "inherit" });
  child.once("exit", (code, signal) => console.error(`Founder local process exited: ${path.basename(command)} (${signal || code})`));
  children.push(child); return child;
}
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function asset(role, originalPath, destinationPath) {
  const [metadata, bytes, sha256] = await Promise.all([probeVideoFile(originalPath), stat(originalPath), digest(originalPath)]);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(originalPath, destinationPath);
  const expected = FOUNDER_REFERENCE_STYLE_ASSETS[role];
  return { id: expected.id, key: expected.key, type: "video/mp4", size: bytes.size, duration: metadata.duration, width: metadata.width, height: metadata.height, hasAudio: metadata.hasAudio, sha256 };
}
async function seed() {
  const [reference, source, checkpoint] = await Promise.all([
    asset("reference", referencePath, path.join(root, FOUNDER_REFERENCE_STYLE_ASSETS.reference.key)),
    asset("source", sourcePath, path.join(root, FOUNDER_REFERENCE_STYLE_ASSETS.source.key)),
    readFile(checkpointPath, "utf8").then(JSON.parse)
  ]);
  const observations = Object.fromEntries((checkpoint.results || []).map((entry) => [entry.role, entry.observation]));
  const profile = createFounderStyleProfileFromObservations({ referenceAsset: reference, observations });
  const manifest = validateFounderReferenceStyleManifest({ version: "founder-reference-style-staging/1", reference, source, profile });
  await writeFile(path.join(root, FOUNDER_REFERENCE_STYLE_ASSETS.profile.key), JSON.stringify(profile, null, 2), { mode: 0o600 });
  await writeFile(path.join(root, "founder-reference-style/v1/manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
async function main() {
  if (!process.env.FOUNDER_TEST_ACCESS_CODE || process.env.FOUNDER_TEST_ACCESS_CODE.length < 32) throw new Error("Set a 32+ character FOUNDER_TEST_ACCESS_CODE in your shell before launch.");
  await Promise.all([stat(referencePath), stat(sourcePath), stat(checkpointPath), stat(chromePath)]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const data = path.join(root, "postgres");
  try { await stat(path.join(data, "PG_VERSION")); } catch { await run("initdb", ["-D", data, "--auth=trust", "--encoding=UTF8"]); }
  const baseEnv = {
    ...process.env, NODE_ENV: "development", DATABASE_URL: `postgresql://127.0.0.1:${port}/cliponaut_founder_reference_style`,
    FOUNDER_REFERENCE_STYLE_LOCAL_MODE: "true", FOUNDER_REFERENCE_STYLE_LOCAL_ROOT: root,
    FOUNDER_REFERENCE_STYLE_STAGING_ENABLED: "true", FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT: "staging", FOUNDER_REFERENCE_STYLE_STAGING_BUCKET: "local-founder-reference-style-staging",
    FOUNDER_CONVERSATIONAL_EDITING_ENABLED: "true", FOUNDER_TEST_ACCESS_SECRET: process.env.FOUNDER_TEST_ACCESS_CODE,
    STORAGE_BUCKET: "local-founder-reference-style-staging", STORAGE_ENDPOINT: "http://127.0.0.1/unused", STORAGE_REGION: "local", STORAGE_ACCESS_KEY_ID: "local", STORAGE_SECRET_ACCESS_KEY: "local", STORAGE_FORCE_PATH_STYLE: "true",
    JOB_WORKER_CONCURRENCY: "1", JOB_MAX_ATTEMPTS: "1", JOB_SCRATCH_DIRECTORY: path.join(root, "scratch"), PUPPETEER_EXECUTABLE_PATH: chromePath, NEXT_PUBLIC_FOUNDER_REFERENCE_STYLE_LOCAL_MODE: "true", PORT: String(appPort)
  };
  const postgres = launch("postgres", ["-D", data, "-h", "127.0.0.1", "-p", String(port)], baseEnv);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await run("createdb", ["-h", "127.0.0.1", "-p", String(port), "cliponaut_founder_reference_style"], { env: baseEnv }).catch(() => {});
  await seed();
  await run(path.join(repository, "node_modules/.bin/tsx"), ["scripts/migrate-jobs.js"], { cwd: repository, env: baseEnv });
  launch(path.join(repository, "node_modules/.bin/tsx"), ["scripts/cliponaut-worker.js"], baseEnv);
  launch(path.join(repository, "node_modules/.bin/next"), ["dev", "-p", String(appPort)], baseEnv);
  console.log(`Founder Reference Style is ready at http://127.0.0.1:${appPort}/founder-test`);
  const stop = () => { for (const child of children.reverse()) child.kill("SIGTERM"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const [code, signal] = await Promise.race(children.map((child) => new Promise((resolve) => child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])))));
  stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!postgres.killed) postgres.kill("SIGTERM");
  if (code && !signal) process.exitCode = Number(code);
}
main().catch((error) => { console.error("Founder Reference Style local launch failed:", error.message); process.exitCode = 1; });

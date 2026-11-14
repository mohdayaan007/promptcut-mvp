/**
 * Starts an isolated, localhost-only founder Reference Style application.
 * It creates no cloud resources and never reads production configuration.
 * A caller supplies FOUNDER_TEST_ACCESS_CODE once; the harness stores it only
 * in its private root (owner-readable) for subsequent local restarts. It is
 * never printed or exposed to the browser.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideoFile } from "@/lib/media/media-probe";
import { createFounderStyleProfileFromColourEvidence, FOUNDER_REFERENCE_STYLE_ASSETS, validateFounderReferenceStyleManifest } from "@/lib/editor-core/founder-reference-style-staging-contract";
import { FOUNDER_REFERENCE_STYLE_REFERENCES } from "@/lib/editor-core/founder-reference-style-staging";
import { extractTargetReferenceFrames } from "@/lib/editor-core/reference-style-media";

const root = process.env.FOUNDER_REFERENCE_STYLE_LOCAL_ROOT || path.join(os.homedir(), ".cliponaut-founder-reference-style-local");
const port = Number(process.env.FOUNDER_REFERENCE_STYLE_LOCAL_PORT || 55432);
const appPort = Number(process.env.PORT || 3000);
const sourcePath = "/Users/ayaan/Gym Outside Test.mp4";
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const accessCodePath = path.join(root, "founder-access-code");

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
async function asset(expected, originalPath) {
  const [metadata, bytes, sha256] = await Promise.all([probeVideoFile(originalPath), stat(originalPath), digest(originalPath)]);
  await mkdir(path.dirname(path.join(root, expected.key)), { recursive: true, mode: 0o700 });
  await copyFile(originalPath, path.join(root, expected.key));
  return { id: expected.id, key: expected.key, type: "video/mp4", size: bytes.size, duration: metadata.duration, width: metadata.width, height: metadata.height, hasAudio: metadata.hasAudio, sha256 };
}
async function seed() {
  const source = await asset(FOUNDER_REFERENCE_STYLE_ASSETS.source, sourcePath);
  const scratch = await mkdtemp(path.join(root, "colour-evidence-"));
  try {
    const sourceEvidence = await extractTargetReferenceFrames({ inputPath: sourcePath, duration: source.duration, scratchDirectory: path.join(scratch, "source"), count: 5 });
    for (const definition of FOUNDER_REFERENCE_STYLE_REFERENCES) {
      await stat(definition.path);
      const reference = await asset(definition, definition.path);
      const referenceEvidence = await extractTargetReferenceFrames({ inputPath: definition.path, duration: reference.duration, scratchDirectory: path.join(scratch, definition.id), count: 5 });
      const profile = JSON.parse(JSON.stringify(createFounderStyleProfileFromColourEvidence({ referenceAsset: reference, sourceMetrics: sourceEvidence.metrics, referenceMetrics: referenceEvidence.metrics })));
      if (process.env.FOUNDER_MKL_LOCAL_EVALUATION_ENABLED === "true") profile.colour.algorithm = "mkl_local_evaluation";
      const manifest = validateFounderReferenceStyleManifest({ version: "founder-reference-style-staging/1", reference, source, profile }, { allowMklLocal: process.env.FOUNDER_MKL_LOCAL_EVALUATION_ENABLED === "true" });
      await writeFile(path.join(root, `founder-reference-style/v1/style-profile-${definition.id}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 });
      await writeFile(path.join(root, `founder-reference-style/v1/manifest-${definition.id}.json`), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function founderAccessCode() {
  const supplied = process.env.FOUNDER_TEST_ACCESS_CODE;
  if (supplied) {
    if (supplied.length < 32) throw new Error("FOUNDER_TEST_ACCESS_CODE must be at least 32 characters.");
    await writeFile(accessCodePath, supplied, { encoding: "utf8", mode: 0o600 });
    return supplied;
  }
  try {
    const info = await lstat(accessCodePath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("unsafe");
    const saved = await readFile(accessCodePath, "utf8");
    if (saved.length < 32) throw new Error("invalid");
    return saved;
  } catch {
    throw new Error("Set FOUNDER_TEST_ACCESS_CODE once (32+ characters). It will be saved locally with owner-only permissions for future launches.");
  }
}
async function main() {
  await Promise.all([stat(sourcePath), stat(chromePath), ...FOUNDER_REFERENCE_STYLE_REFERENCES.map((asset) => stat(asset.path))]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const accessCode = await founderAccessCode();
  const data = path.join(root, "postgres");
  try { await stat(path.join(data, "PG_VERSION")); } catch { await run("initdb", ["-D", data, "--auth=trust", "--encoding=UTF8"]); }
  const baseEnv = {
    ...process.env, NODE_ENV: "development", DATABASE_URL: `postgresql://127.0.0.1:${port}/cliponaut_founder_reference_style`,
    FOUNDER_REFERENCE_STYLE_LOCAL_MODE: "true", FOUNDER_REFERENCE_STYLE_LOCAL_ROOT: root,
    FOUNDER_REFERENCE_STYLE_STAGING_ENABLED: "true", FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT: "staging", FOUNDER_REFERENCE_STYLE_STAGING_BUCKET: "local-founder-reference-style-staging",
    FOUNDER_CONVERSATIONAL_EDITING_ENABLED: "true", FOUNDER_TEST_ACCESS_SECRET: accessCode,
    STORAGE_BUCKET: "local-founder-reference-style-staging", STORAGE_ENDPOINT: "http://127.0.0.1/unused", STORAGE_REGION: "local", STORAGE_ACCESS_KEY_ID: "local", STORAGE_SECRET_ACCESS_KEY: "local", STORAGE_FORCE_PATH_STYLE: "true",
    JOB_WORKER_CONCURRENCY: "1", JOB_MAX_ATTEMPTS: "1", JOB_SCRATCH_DIRECTORY: path.join(root, "scratch"), PUPPETEER_EXECUTABLE_PATH: chromePath, NEXT_PUBLIC_FOUNDER_REFERENCE_STYLE_LOCAL_MODE: "true", FOUNDER_MKL_LOCAL_EVALUATION_ENABLED: process.env.FOUNDER_MKL_LOCAL_EVALUATION_ENABLED || "false", FOUNDER_MKL_LOCAL_PYTHON: process.env.FOUNDER_MKL_LOCAL_PYTHON || "/private/tmp/cliponaut-colour-algorithm-eval/bin/python", PORT: String(appPort)
  };
  const postgres = launch("postgres", ["-D", data, "-h", "127.0.0.1", "-p", String(port)], baseEnv);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await run("createdb", ["-h", "127.0.0.1", "-p", String(port), "cliponaut_founder_reference_style"], { env: baseEnv }).catch(() => {});
  await seed();
  await run(path.join(repository, "node_modules/.bin/tsx"), ["scripts/migrate-jobs.js"], { cwd: repository, env: baseEnv });
  launch(path.join(repository, "node_modules/.bin/tsx"), ["scripts/cliponaut-worker.js"], baseEnv);
  launch(path.join(repository, "node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", String(appPort)], baseEnv);
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

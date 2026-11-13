import { spawn } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateReferenceStyleV1Composition } from "@/lib/editor-core/reference-style-v1-composition";

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const hex = /^#[0-9a-f]{6}$/i;
function renderError(message) { return new Error(`Founder Reference Style renderer: ${message}`); }
function run(command, args, { cwd, executionController } = {}) {
  executionController?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true", PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium" } });
    let stderr = "";
    executionController?.attach(child);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once("error", (error) => { executionController?.detach(child); reject(error); });
    child.once("close", (code) => { executionController?.detach(child); code === 0 ? resolve() : reject(new Error(stderr || `${path.basename(command)} failed`)); });
  });
}
function html({ composition, duration }) {
  const title = composition.title;
  const animation = title.animation === "phrase_slide" ? "slide" : "rise";
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#101315}.source{position:absolute;inset:0;width:1280px;height:720px;object-fit:contain}.title-wrap{position:absolute;left:${title.x}px;top:${title.y}px;width:${title.width}px;z-index:2;pointer-events:none}.title{display:inline-block;max-width:100%;padding:14px 18px 16px;border-left:5px solid ${title.color};background:linear-gradient(90deg,rgba(7,12,16,.62),rgba(7,12,16,.18));color:${title.color};font:700 54px/.92 'Liberation Sans Narrow','Arial Narrow',Arial,sans-serif;letter-spacing:-1px;text-transform:uppercase;overflow-wrap:anywhere;text-shadow:0 2px 10px rgba(0,0,0,.42)}@keyframes rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:translateY(0)}}@keyframes slide{from{opacity:0;transform:translateX(-42px)}to{opacity:1;transform:translateX(0)}}.title{animation:${animation} .5s cubic-bezier(.16,1,.3,1) both}</style></head><body><main data-composition-id="founder-reference-style" data-start="0" data-duration="${duration.toFixed(3)}" data-width="1280" data-height="720" data-fps="30"><video class="source" src="source.mp4" playsinline data-start="0" data-duration="${duration.toFixed(3)}" data-media-start="0" data-track-index="0"></video><div class="title-wrap" data-start="${title.start}" data-duration="${(title.end - title.start).toFixed(3)}" data-track-index="1"><div class="title">${esc(title.text)}</div></div></main></body></html>`;
}
export function hyperframesBinary() {
  const configured = process.env.HYPERFRAMES_BIN;
  if (configured) { if (!path.isAbsolute(configured) || path.basename(configured) !== "hyperframes") throw renderError("invalid server HyperFrames binary configuration"); return configured; }
  return path.join(process.cwd(), "node_modules", ".bin", "hyperframes");
}
export async function renderFounderReferenceStyleComposition({ composition, sourcePath, outputPath, duration, temporaryDirectory, executionController, rendererPath = hyperframesBinary() }) {
  validateReferenceStyleV1Composition(composition, duration);
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath) || !path.isAbsolute(temporaryDirectory) || !path.isAbsolute(rendererPath) || !hex.test(composition.title.color)) throw renderError("trusted paths and title data are required");
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const visualPath = path.join(temporaryDirectory, "visual.mp4");
  try {
    await symlink(sourcePath, path.join(temporaryDirectory, "source.mp4"));
    await writeFile(path.join(temporaryDirectory, "index.html"), html({ composition, duration }), { encoding: "utf8", mode: 0o600 });
    await run(rendererPath, ["render", "--quality", "looks", "--workers", "1", "-o", visualPath], { cwd: temporaryDirectory, executionController });
    // HyperFrames renders at a fixed frame cadence. Pad its final visual frame
    // and bound the mux to the original media duration so the source audio and
    // timeline are never shortened by a fractional-frame render discrepancy.
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", visualPath, "-i", sourcePath, "-filter_complex", "[0:v]tpad=stop_mode=clone:stop_duration=1[v]", "-map", "[v]", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", duration.toFixed(3), outputPath], { executionController });
    return { outputPath, renderer: "hyperframes-founder-reference-style/1" };
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {}); }
}

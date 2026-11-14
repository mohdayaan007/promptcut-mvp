import { spawn as nodeSpawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { EditExecutionCancelledError } from "@/lib/editor-core/edit-executor";

const EVALUATION_ROOT = "/private/tmp/cliponaut-colour-algorithm-eval";

function localConfig() {
  if (process.env.FOUNDER_REFERENCE_STYLE_LOCAL_MODE !== "true" || process.env.FOUNDER_MKL_LOCAL_EVALUATION_ENABLED !== "true") {
    throw new Error("Founder-local MKL evaluation is disabled");
  }
  const python = process.env.FOUNDER_MKL_LOCAL_PYTHON || path.join(EVALUATION_ROOT, "bin", "python");
  const runner = process.env.FOUNDER_MKL_LOCAL_RUNNER || path.join(process.cwd(), "scripts", "founder-mkl-local-evaluation.py");
  if (!path.isAbsolute(python) || !python.startsWith(`${EVALUATION_ROOT}${path.sep}`) || !path.isAbsolute(runner) || path.basename(runner) !== "founder-mkl-local-evaluation.py") {
    throw new Error("Founder-local MKL evaluation configuration is invalid");
  }
  return { python, runner };
}

export function validateFounderMklReport(value) {
  if (!value || value.version !== "founder-mkl-evaluation/1" || value.status !== "ok" || !Number.isInteger(value.frameCount) || value.frameCount < 1 ||
    value.matrixFinite !== true || value.outputFinite !== true || !Number.isFinite(value.matrixCondition) || value.matrixCondition < 1 || value.matrixCondition > 1e12) {
    throw new Error("Founder-local MKL evaluation produced an invalid transformation");
  }
  return Object.freeze({ frameCount: value.frameCount, matrixCondition: value.matrixCondition });
}

function run(command, args, { executionController, spawn = nodeSpawn } = {}) {
  executionController?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const finish = (error) => { executionController?.detach(child); error ? reject(error) : resolve(); };
    executionController?.attach(child);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once("error", (error) => finish(executionController?.isCancelled() ? new EditExecutionCancelledError() : error));
    child.once("close", (code) => executionController?.isCancelled() ? finish(new EditExecutionCancelledError()) : code === 0 ? finish() : finish(new Error(stderr || "Founder-local MKL evaluation failed")));
  });
}

/**
 * Invokes the GPL-dependent evaluator only in the isolated founder-local
 * environment. The Python dependency is intentionally absent from package.json
 * and the production image. The JSON report contains numerical evidence only.
 */
export async function renderFounderLocalMkl({ sourcePath, referencePath, outputPath, reportPath, executionController, runCommand = run, read = readFile, remove = rm }) {
  if (![sourcePath, referencePath, outputPath, reportPath].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new Error("Founder-local MKL evaluation needs trusted paths");
  const { python, runner } = localConfig();
  try {
    await runCommand(python, [runner, "--source", sourcePath, "--reference", referencePath, "--output", outputPath, "--report", reportPath], { executionController });
    return validateFounderMklReport(JSON.parse(await read(reportPath, "utf8")));
  } catch (error) {
    await remove(outputPath, { force: true }).catch(() => {});
    await remove(reportPath, { force: true }).catch(() => {});
    throw error;
  }
}

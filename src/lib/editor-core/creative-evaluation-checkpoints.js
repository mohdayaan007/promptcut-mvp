import crypto from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

const VERSION = "ce0-checkpoint/1";
const stages = new Set(["transcription", "reference", "overview", "fine", "plan", "cleanup"]);
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createEvaluationIdentity(input) { return digest({ version: VERSION, ...input }); }

export function createPrivateCheckpointStore(directory) {
  const file = (identity, stage) => path.join(directory, `${identity}-${stage}.json`);
  async function save(record) {
    if (!record?.identity || !stages.has(record.stage) || !["completed", "budget_exceeded", "invalid_result", "cleanup_pending", "cleanup_succeeded", "cleanup_failed"].includes(record.status)) throw new Error("Invalid CE-0 checkpoint");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = file(record.identity, record.stage);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: VERSION, ...record }), { mode: 0o600 });
    await rename(temporary, target);
  }
  async function load(identity, stage) {
    try {
      const parsed = JSON.parse(await readFile(file(identity, stage), "utf8"));
      if (parsed.version !== VERSION || parsed.identity !== identity || parsed.stage !== stage || !stages.has(stage)) return null;
      return parsed;
    } catch { return null; }
  }
  return Object.freeze({ save, load });
}

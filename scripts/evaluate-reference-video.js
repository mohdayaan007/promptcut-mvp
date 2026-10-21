import { parseReferenceVideoEvaluationArgs, runReferenceVideoEvaluation } from "@/lib/editor-core/reference-video-evaluation";

const USAGE = `Usage: npm exec tsx scripts/evaluate-reference-video.js -- --reference /absolute/reference.mp4 [--original /absolute/original.mp4] [--output-dir /tmp/cliponaut-rv3a-review]\n\nDry run is the default and never calls Gemini. Live mode requires --live, --authorize-live-gemini, and --output-dir.`;

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

async function main() {
  const options = parseReferenceVideoEvaluationArgs(process.argv.slice(2));
  if (options.help) console.log(USAGE);
  else console.log(JSON.stringify((await runReferenceVideoEvaluation({ ...options, signal: controller.signal })).summary, null, 2));
}

main().catch((error) => {
  console.error(error?.message || "Reference-video evaluation could not complete safely.");
  process.exitCode = 1;
});

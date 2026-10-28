const { spawn } = require("node:child_process");

const suites = [
  "tests/conversation-state.test.js",
  "tests/conversation-presentation.test.js",
  "tests/conversation-ui.test.js",
  "tests/founder-test-access.test.js",
  "tests/hosted-phase4-normal.acceptance.test.js"
];

(async () => {
  for (const suite of suites) {
    console.log(`\nPhase 4 offline: ${suite}`);
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", suite], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
    if (exitCode !== 0) process.exit(exitCode);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

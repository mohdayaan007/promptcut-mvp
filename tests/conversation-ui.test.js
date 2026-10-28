import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("preview renders restored media under the Undo cover and labels retained media truthfully", () => {
  const directory = mkdtempSync(path.join(process.cwd(), "node_modules/.cliponaut-ui-test-"));
  try {
    const output = path.join(directory, "workspace.cjs");
    buildSync({ entryPoints: ["src/components/cliponaut/Workspace.js"], outfile: output, bundle: true, platform: "node", format: "cjs", jsx: "automatic", loader: { ".js": "jsx" }, alias: { "@": path.join(process.cwd(), "src") }, packages: "external", logLevel: "silent" });
    const { Workspace } = createRequire(import.meta.url)(output);
    const props = { videos: [], restoredSources: [], messages: [], exportQuality: "standard", resultUrl: "/test-output.mp4", previewMode: "restoring", restoringResultUrl: "/test-output.mp4", restoringOriginal: false, status: "done", isUndoing: true };
    const restoring = renderToStaticMarkup(React.createElement(Workspace, props));
    assert.match(restoring, /<video[^>]*src="\/test-output.mp4"/);
    assert.match(restoring, /Restoring previous edit/);
    const beforeReplacement = renderToStaticMarkup(React.createElement(Workspace, { ...props, restoringResultUrl: null }));
    assert.doesNotMatch(beforeReplacement, /<video/);
    const retained = renderToStaticMarkup(React.createElement(Workspace, { ...props, previewMode: "normal", status: "rendering", isUndoing: false }));
    assert.match(retained, /Previous edit/);
    assert.doesNotMatch(retained, />Ready</);
    const done = renderToStaticMarkup(React.createElement(Workspace, { ...props, previewMode: "normal", isUndoing: false }));
    assert.match(done, />Ready</);
    assert.doesNotMatch(done, /Previous edit/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

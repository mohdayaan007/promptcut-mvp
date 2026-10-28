import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("empty editor renders browser media preflight errors as an accessible alert", async () => {
  const component = await readFile(path.join(process.cwd(), "src/components/cliponaut/EmptyEditorState.js"), "utf8");
  assert.match(component, /error,/);
  assert.match(component, /error \? <p className="cliponaut-empty-editor-error" role="alert">\{error\}<\/p> : null/);
});

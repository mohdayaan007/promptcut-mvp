import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Docker context excludes credentials, local media, checkpoints, and development artifacts", async () => {
  const ignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  for (const rule of [".env", ".codex-stage5", "node_modules", "*.mp4", "*.mov", "*.jpg", "*.png", "cliponaut-*-review", "founder-reference-style-analysis"]) {
    assert.match(ignore, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

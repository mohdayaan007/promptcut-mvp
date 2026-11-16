import assert from "node:assert/strict";
import test from "node:test";
import { validateFounderMklReport } from "../src/lib/editor-core/founder-mkl-local.js";

test("founder-local MKL report accepts finite bounded evidence only", () => {
  assert.deepEqual(validateFounderMklReport({ version: "founder-mkl-evaluation/1", status: "ok", frameCount: 460, matrixFinite: true, outputFinite: true, matrixCondition: 1.44 }), { frameCount: 460, matrixCondition: 1.44 });
  assert.throws(() => validateFounderMklReport({ version: "founder-mkl-evaluation/1", status: "ok", frameCount: 1, matrixFinite: false, outputFinite: true, matrixCondition: 1 }), /invalid transformation/);
  assert.throws(() => validateFounderMklReport({ version: "founder-mkl-evaluation/1", status: "ok", frameCount: 1, matrixFinite: true, outputFinite: true, matrixCondition: Infinity }), /invalid transformation/);
  assert.throws(() => validateFounderMklReport({ version: "founder-mkl-evaluation/1", status: "ok", frameCount: 1, matrixFinite: true, outputFinite: true, matrixCondition: 1e13 }), /invalid transformation/);
});

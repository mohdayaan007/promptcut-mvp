import assert from "node:assert/strict";
import test from "node:test";
import { customerMklRuntimeConfig, preparedMklRuntimeConfig } from "../src/lib/editor-core/prepared-mkl-runtime.js";

const prepared = {
  CLIPONAUT_MKL_RUNTIME_PREPARED: "true",
  CLIPONAUT_MKL_PYTHON: "/opt/cliponaut-mkl-venv/bin/python",
  CLIPONAUT_MKL_RUNNER: "/app/scripts/founder-mkl-local-evaluation.py"
};

test("prepared MKL runtime stays disabled until an explicit image gate is set", () => {
  assert.throws(() => preparedMklRuntimeConfig({ env: {} }), /disabled/);
  assert.throws(() => preparedMklRuntimeConfig({ env: { ...prepared, CLIPONAUT_MKL_PYTHON: "python" } }), /Python path/);
  assert.deepEqual(preparedMklRuntimeConfig({ env: prepared }), {
    version: "cliponaut-mkl-runtime/1",
    python: prepared.CLIPONAUT_MKL_PYTHON,
    runner: prepared.CLIPONAUT_MKL_RUNNER
  });
});

test("customer MKL cannot be invoked merely because the runtime was prepared", () => {
  assert.throws(() => customerMklRuntimeConfig({ env: prepared }), /pending safety and legal approval/);
  assert.deepEqual(customerMklRuntimeConfig({ env: { ...prepared, CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED: "true" } }), preparedMklRuntimeConfig({ env: prepared }));
});

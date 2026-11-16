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

test("founder-only MKL can run only for an explicitly authorized founder with both separate gates", () => {
  const founderOnly = {
    ...prepared,
    CLIPONAUT_MKL_FOUNDER_ONLY_TEST_ENABLED: "true",
    CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED: "false"
  };
  assert.throws(() => customerMklRuntimeConfig({ env: founderOnly }), /disabled pending safety and legal approval/);
  assert.throws(() => customerMklRuntimeConfig({ env: founderOnly, founderAuthorized: false }), /disabled pending safety and legal approval/);
  assert.deepEqual(customerMklRuntimeConfig({ env: founderOnly, founderAuthorized: true }), preparedMklRuntimeConfig({ env: prepared }));
  assert.throws(() => customerMklRuntimeConfig({ env: { ...founderOnly, CLIPONAUT_MKL_FOUNDER_ONLY_TEST_ENABLED: "false" }, founderAuthorized: true }), /disabled pending safety and legal approval/);
  assert.throws(() => customerMklRuntimeConfig({ env: { ...founderOnly, CLIPONAUT_MKL_RUNTIME_PREPARED: "false" }, founderAuthorized: true }), /disabled/);
});

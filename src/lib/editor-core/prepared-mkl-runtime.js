import path from "node:path";

const PREPARED_RUNTIME_VERSION = "cliponaut-mkl-runtime/1";

function requiredPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`Prepared MKL ${label} is invalid`);
  return value;
}

/**
 * A prepared image is not a customer release. The caller must separately pass
 * the customer gate after reference-video safety and GPL deployment review.
 */
export function preparedMklRuntimeConfig({ env = process.env } = {}) {
  if (env.CLIPONAUT_MKL_RUNTIME_PREPARED !== "true") throw new Error("Prepared MKL runtime is disabled");
  const python = requiredPath(env.CLIPONAUT_MKL_PYTHON, "Python path");
  const runner = requiredPath(env.CLIPONAUT_MKL_RUNNER, "runner path");
  if (path.basename(runner) !== "founder-mkl-local-evaluation.py") throw new Error("Prepared MKL runner is invalid");
  return Object.freeze({ version: PREPARED_RUNTIME_VERSION, python, runner });
}

export function customerMklRuntimeConfig({ env = process.env, founderAuthorized = false } = {}) {
  const founderOnly = founderAuthorized === true && env.CLIPONAUT_MKL_FOUNDER_ONLY_TEST_ENABLED === "true";
  if (env.CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED !== "true" && !founderOnly) {
    throw new Error("Customer MKL release is disabled pending safety and legal approval");
  }
  return preparedMklRuntimeConfig({ env });
}

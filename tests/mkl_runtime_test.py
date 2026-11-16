"""Focused tests for the separately installed MKL Python component.

Run with the same interpreter that the prepared image uses, for example:
  /opt/cliponaut-mkl-venv/bin/python -m unittest tests/mkl_runtime_test.py
"""
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np


RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "founder-mkl-local-evaluation.py"
SPEC = importlib.util.spec_from_file_location("cliponaut_mkl_runner", RUNNER)
RUNNER_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER_MODULE)


class MklRuntimeTests(unittest.TestCase):
    def test_runtime_check_imports_pinned_component(self):
        result = subprocess.run([sys.executable, str(RUNNER), "--runtime-check"], check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["version"], "cliponaut-mkl-runtime/1")
        self.assertEqual(payload["status"], "ok")

    def test_missing_dependency_fails_before_media_processing(self):
        result = subprocess.run([sys.executable, "-S", str(RUNNER), "--runtime-check"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MKL runtime dependency missing", result.stderr)

    def test_flat_source_rejects_degenerate_mkl_transform(self):
        source = np.zeros((8, 8, 3), dtype=np.float64)
        reference = np.arange(8 * 8 * 3, dtype=np.float64).reshape(8, 8, 3)
        with self.assertRaisesRegex(RuntimeError, "degenerate MKL covariance transform"):
            RUNNER_MODULE.transformation(source, reference)


if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import tempfile
import unittest
from typing import Any, Dict, Optional


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R_RENDERER = os.path.join(PROJECT_ROOT, "renderer", "r_renderer.R")


def _rscript_bin() -> str:
    if os.name == "nt":
        return (
            os.environ.get("RSCRIPT_BIN")
            or os.environ.get("R_BIN")
            or r"C:\Users\SZC\.conda\envs\Machine-learning\Scripts\Rscript.exe"
        )
    return os.environ.get("RSCRIPT_BIN") or os.environ.get("R_BIN") or "Rscript"


def _process_env(overrides: Optional[Dict[str, str]] = None) -> dict:
    env = os.environ.copy()
    r_bin = _rscript_bin()
    env_root = os.path.dirname(os.path.dirname(r_bin)) if os.path.isabs(r_bin) else ""
    if env_root:
        extra_paths = [
            env_root,
            os.path.join(env_root, "Scripts"),
            os.path.join(env_root, "Library", "bin"),
            os.path.join(env_root, "Library", "mingw-w64", "bin"),
            os.path.join(env_root, "Lib", "R", "bin"),
            os.path.join(env_root, "Lib", "R", "bin", "x64"),
        ]
        env["PATH"] = os.pathsep.join(extra_paths + [env.get("PATH", "")])
    if overrides:
        env.update(overrides)
    return env


def _run_r_renderer(
    script: str,
    *,
    extra_payload: Optional[Dict[str, Any]] = None,
    env_overrides: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "script": script,
        "editLog": [],
        "renderOptions": {"width_in": 6, "height_in": 4},
    }
    if extra_payload:
        payload.update(extra_payload)

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        payload_file = handle.name

    try:
        proc = subprocess.run(
            [_rscript_bin(), "--vanilla", R_RENDERER, "--payload-file", payload_file],
            cwd=PROJECT_ROOT,
            env=_process_env(env_overrides),
            text=True,
            encoding="utf-8",
            errors="strict",
            capture_output=True,
            timeout=30,
        )
    finally:
        try:
            os.unlink(payload_file)
        except OSError:
            pass

    stdout = proc.stdout.strip()
    if not stdout:
        raise AssertionError(f"R renderer returned no stdout. code={proc.returncode} stderr={proc.stderr}")
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"R renderer did not return JSON. code={proc.returncode} stdout={stdout[:500]} stderr={proc.stderr}"
        ) from exc


def _diagnostic_category(result: Dict[str, Any]) -> Optional[str]:
    diagnostic = result.get("diagnostic") or {}
    return diagnostic.get("category") or diagnostic.get("type") or diagnostic.get("kind")


@unittest.skipUnless(os.path.exists(_rscript_bin()), "Rscript is not available")
class TestRRuntimeDiagnostics(unittest.TestCase):
    def test_runtime_failures_have_structured_categories_and_compatible_messages(self):
        fixtures = {
            "syntax_error": "x <- c(1, 2\n",
            "missing_package": "library(scifigure_missing_package_for_diagnostics)",
            "missing_data": "missing_data_object_for_diagnostics",
            "missing_file": 'readLines("scifigure_missing_file_for_diagnostics.txt")',
            "permission_denied": 'stop("Permission denied while opening renderer input")',
            "runtime_error": 'stop("generic runtime failure for diagnostics")',
        }

        for expected_category, script in fixtures.items():
            with self.subTest(category=expected_category):
                result = _run_r_renderer(script)
                self.assertEqual(result.get("status"), "error", result)
                self.assertEqual(_diagnostic_category(result), expected_category, result)
                self.assertTrue(result.get("message", "").startswith("R script failed:"), result)
                diagnostic = result.get("diagnostic") or {}
                self.assertEqual(diagnostic.get("severity"), "error", result)
                self.assertEqual(diagnostic.get("schemaVersion"), "1.0", result)
                self.assertIn("conditionClass", diagnostic, result)

    def test_missing_font_warning_is_structured_without_changing_success(self):
        result = _run_r_renderer(
            'warning("font family \'SciFigureMissingFont\' not found in font database")\nplot(1:2, 1:2)'
        )

        self.assertEqual(result.get("status"), "success", result)
        self.assertIn("font family", " ".join(result.get("warnings", [])).lower())
        warning_diagnostics = result.get("warningDiagnostics") or []
        self.assertTrue(
            any(item.get("category") == "missing_font" for item in warning_diagnostics),
            result,
        )
        self.assertEqual((result.get("diagnostic") or {}).get("category"), "missing_font", result)
        self.assertEqual((result.get("diagnostic") or {}).get("severity"), "warning", result)

    def test_generic_missing_function_is_not_assumed_to_be_a_missing_package(self):
        result = _run_r_renderer("scifigure_unknown_function_for_diagnostics()")

        self.assertEqual(result.get("status"), "error", result)
        self.assertEqual(_diagnostic_category(result), "runtime_error", result)

    def test_generic_subscript_out_of_bounds_is_not_assumed_to_be_missing_data(self):
        result = _run_r_renderer("values <- list(1); values[[2]]")

        self.assertEqual(result.get("status"), "error", result)
        self.assertEqual(_diagnostic_category(result), "runtime_error", result)

    def test_runtime_inventory_reports_isolated_environment_contract(self):
        with tempfile.TemporaryDirectory() as temp_root:
            expected_paths = {
                "HOME": os.path.join(temp_root, "home"),
                "USERPROFILE": os.path.join(temp_root, "profile"),
                "TMPDIR": os.path.join(temp_root, "tmpdir"),
                "TMP": os.path.join(temp_root, "tmp"),
                "TEMP": os.path.join(temp_root, "temp"),
                "R_USER": os.path.join(temp_root, "r-user"),
                "XDG_CACHE_HOME": os.path.join(temp_root, "xdg-cache"),
            }
            for path in expected_paths.values():
                os.makedirs(path, exist_ok=True)
            result = _run_r_renderer(
                "plot(1:2, 1:2)",
                env_overrides={**expected_paths, "TZ": "UTC"},
            )

        self.assertEqual(result.get("status"), "success", result)
        inventory = result.get("runtimeInventory") or {}
        environment = inventory.get("environment") or {}
        self.assertEqual(environment.get("tz"), "UTC", inventory)
        expected_contract_keys = {
            "home": "HOME",
            "userProfile": "USERPROFILE",
            "tmpdir": "TMPDIR",
            "tmp": "TMP",
            "temp": "TEMP",
            "rUser": "R_USER",
            "xdgCacheHome": "XDG_CACHE_HOME",
        }
        for contract_key, environment_name in expected_contract_keys.items():
            path = expected_paths[environment_name]
            expected = os.path.abspath(path).replace("\\", "/")
            self.assertEqual(environment.get(contract_key), expected, inventory)
        self.assertNotIn("HOME", environment)
        self.assertNotIn("USERPROFILE", environment)

    def test_runtime_inventory_declares_docker_locale_package_and_font_contracts(self):
        result = _run_r_renderer("plot(1:2, 1:2)")

        self.assertEqual(result.get("status"), "success", result)
        inventory = result.get("runtimeInventory") or {}
        locale = inventory.get("locale") or {}
        categories = locale.get("categories") or {}
        self.assertEqual(categories.get("LC_COLLATE"), "C", inventory)
        self.assertEqual(
            (locale.get("contract") or {}).get("ctypeEncoding"),
            "UTF-8",
            inventory,
        )
        self.assertIn("textshaping", inventory.get("packages") or {}, inventory)
        font_candidates = (inventory.get("fonts") or {}).get("candidates") or {}
        self.assertIn("FreeSans", font_candidates, inventory)


if __name__ == "__main__":
    unittest.main()

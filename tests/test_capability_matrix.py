import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "capability_matrix"
CATALOG_PATH = FIXTURE_ROOT / "matrix.json"
R_RENDERER = PROJECT_ROOT / "renderer" / "r_renderer.R"

sys.path.insert(0, str(PROJECT_ROOT / "renderer"))
from introspector import replay_render  # noqa: E402


FORBIDDEN_FIXTURE_PATTERNS = (
    r"\bread_csv\s*\(",
    r"\bread_excel\s*\(",
    r"\bread\.csv\s*\(",
    r"\bread\.table\s*\(",
    r"\bopen\s*\(",
    r"uploaded_file_paths",
    r"scifigure\.db",
    r"(?:^|[\\/])data[\\/]",
)


def load_catalog():
    with CATALOG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_synthetic_fixture(relative_path: str) -> str:
    fixture_path = (FIXTURE_ROOT / relative_path).resolve()
    if FIXTURE_ROOT.resolve() not in fixture_path.parents:
        raise AssertionError(f"Fixture escaped capability matrix root: {relative_path}")
    source = fixture_path.read_text(encoding="utf-8")
    for pattern in FORBIDDEN_FIXTURE_PATTERNS:
        if re.search(pattern, source, flags=re.IGNORECASE | re.MULTILINE):
            raise AssertionError(f"Fixture {relative_path} is not synthetic-only; matched {pattern}")
    return source


def rscript_bin():
    configured = os.environ.get("RSCRIPT_BIN") or os.environ.get("R_BIN")
    if configured:
        return configured
    windows_default = Path(r"C:\Users\SZC\.conda\envs\Machine-learning\Scripts\Rscript.exe")
    if os.name == "nt" and windows_default.exists():
        return str(windows_default)
    return shutil.which("Rscript")


def r_process_env():
    env = os.environ.copy()
    executable = rscript_bin()
    env_root = str(Path(executable).resolve().parents[1]) if executable and os.path.isabs(executable) else ""
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
    return env


def run_r_fixture(script: str):
    payload = {
        "script": script,
        "editLog": [],
        "renderOptions": {"width_in": 6, "height_in": 4},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        payload_path = handle.name
    try:
        process = subprocess.run(
            [rscript_bin(), str(R_RENDERER), "--payload-file", payload_path],
            cwd=PROJECT_ROOT,
            env=r_process_env(),
            text=True,
            capture_output=True,
            timeout=45,
        )
    finally:
        try:
            os.unlink(payload_path)
        except OSError:
            pass
    if not process.stdout.strip():
        raise AssertionError(
            f"R fixture returned no JSON: code={process.returncode} stderr={process.stderr[:1000]}"
        )
    result = json.loads(process.stdout)
    if result.get("status") != "success":
        raise AssertionError(f"R fixture failed: {result}")
    return result


def validate_manifest(testcase, fixture_id, manifest):
    objects = manifest.get("objects", [])
    testcase.assertTrue(objects, f"{fixture_id}: empty manifest")

    object_ids = [obj.get("id") for obj in objects]
    testcase.assertNotIn(None, object_ids, f"{fixture_id}: object without id")
    testcase.assertEqual(len(object_ids), len(set(object_ids)), f"{fixture_id}: duplicate object ids")

    instance_keys = [obj.get("identity", {}).get("instanceKey") for obj in objects]
    testcase.assertNotIn(None, instance_keys, f"{fixture_id}: object without instanceKey")
    testcase.assertEqual(len(instance_keys), len(set(instance_keys)), f"{fixture_id}: duplicate instanceKey")

    for obj in objects:
        editable = sorted(set(obj.get("editable", [])))
        capability_props = sorted({item.get("prop") for item in obj.get("propertyCapabilities", [])})
        testcase.assertEqual(
            editable,
            capability_props,
            f"{fixture_id}: editable/capability mismatch for {obj.get('id')}",
        )


def validate_entry(testcase, entry, manifests):
    all_objects = []
    for manifest in manifests:
        validate_manifest(testcase, entry["id"], manifest)
        all_objects.extend(manifest.get("objects", []))

    kind_counts = Counter(obj.get("kind") for obj in all_objects)
    role_set = {obj.get("role") for obj in all_objects}
    object_map = {obj.get("id"): obj for obj in all_objects}

    for kind, minimum in entry.get("minKindCounts", {}).items():
        testcase.assertGreaterEqual(kind_counts[kind], minimum, f"{entry['id']}: missing kind {kind}")
    for role in entry.get("requiredRoles", []):
        testcase.assertIn(role, role_set, f"{entry['id']}: missing role {role}")
    for object_id in entry.get("requiredIds", []):
        testcase.assertIn(object_id, object_map, f"{entry['id']}: missing object {object_id}")
    for relation in entry.get("relations", []):
        source = object_map.get(relation["from"])
        testcase.assertIsNotNone(source, f"{entry['id']}: relation source missing {relation['from']}")
        actual = source.get("identity", {}).get("relation", {}).get(relation["field"])
        testcase.assertEqual(
            actual,
            relation["equals"],
            f"{entry['id']}: invalid relation {relation['from']}.{relation['field']}",
        )


class TestCapabilityMatrix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog()
        if cls.catalog.get("schemaVersion") != "1.0":
            raise AssertionError("Unsupported capability matrix schema")

    def test_python_capability_matrix(self):
        for entry in self.catalog.get("python", []):
            with self.subTest(entry=entry["id"]):
                source = read_synthetic_fixture(entry["file"])
                result = replay_render(source)
                self.assertEqual(result.get("status"), "success", f"{entry['id']}: render failed")
                figures = result.get("figures", [])
                self.assertEqual(len(figures), entry.get("expectedFigures", 1), f"{entry['id']}: figure count")
                self.assertTrue(all(figure.get("svg") for figure in figures), f"{entry['id']}: empty SVG")
                validate_entry(self, entry, [figure.get("manifest", {}) for figure in figures])

    @unittest.skipUnless(rscript_bin() and Path(rscript_bin()).exists(), "Rscript is not available")
    def test_r_capability_matrix(self):
        for entry in self.catalog.get("r", []):
            with self.subTest(entry=entry["id"]):
                source = read_synthetic_fixture(entry["file"])
                result = run_r_fixture(source)
                self.assertTrue(result.get("svg"), f"{entry['id']}: empty SVG")
                validate_entry(self, entry, [result.get("manifest", {})])


if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.test_capability_matrix import read_synthetic_fixture, rscript_bin
from tests.test_r_renderer import PROJECT_ROOT, R_RENDERER, _backend_patch, _process_env, _run_r_renderer


OPTIONAL_EXTENSION_PACKAGES = (
    "ggrepel",
    "ggnewscale",
    "sf",
    "ggraph",
    "igraph",
    "tidygraph",
    "semPlot",
    "DiagrammeR",
)


def _run_r_renderer_raw(script: str):
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
            [rscript_bin(), "--vanilla", str(R_RENDERER), "--payload-file", payload_path],
            cwd=PROJECT_ROOT,
            env=_process_env(),
            text=True,
            encoding="utf-8",
            errors="strict",
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
            f"R renderer returned no JSON: code={process.returncode} stderr={process.stderr[:1000]}"
        )
    return json.loads(process.stdout)


def _object(result, gid):
    return next(obj for obj in result["manifest"]["objects"] if obj.get("id") == gid)


@unittest.skipUnless(rscript_bin() and Path(rscript_bin()).exists(), "Rscript is not available")
class TestRWP8ExtensionBoundaries(unittest.TestCase):
    def test_runtime_inventory_reports_all_extension_package_versions_without_loading_them(self):
        result = _run_r_renderer('plot(1:2, 1:2, main="Runtime inventory")')
        packages = result["runtimeInventory"]["packages"]
        for package in OPTIONAL_EXTENSION_PACKAGES:
            self.assertIn(package, packages)
            self.assertIsInstance(packages[package]["installed"], bool)
            if packages[package]["installed"]:
                self.assertRegex(packages[package]["version"], r"^\d")
            else:
                self.assertIsNone(packages[package]["version"])

    def test_ggrepel_named_geoms_preserve_preview_but_remain_explicitly_readonly(self):
        source = read_synthetic_fixture("r/ggrepel_shadow.R")
        result = _run_r_renderer(source)
        objects = [
            obj for obj in result["manifest"]["objects"]
            if obj.get("source", {}).get("artistClass") in {"GeomTextRepel", "GeomLabelRepel"}
        ]
        self.assertEqual(len(objects), 2, objects)
        self.assertNotIn('data-fig-id="r.text.', result["svg"])
        for obj in objects:
            self.assertEqual(obj["kind"], "unsupported")
            self.assertEqual(obj["editable"], [])
            self.assertEqual(obj["currentProps"]["extensionPackage"], "ggrepel")
            self.assertEqual(obj["currentProps"]["extensionSupport"], "shadow_unsupported")
            self.assertIn("repel layout", obj["currentProps"]["unsupportedReason"])

        rejected = _run_r_renderer(source, [_backend_patch(objects[0], "color", "#00AA00")])
        self.assertTrue(rejected["conflict"], rejected)
        self.assertEqual(rejected["applied"], [], rejected)

    def test_ggnewscale_renamed_aesthetic_is_reported_without_scale_or_group_writeback(self):
        source = read_synthetic_fixture("r/ggnewscale_shadow.R")
        result = _run_r_renderer(source)
        report = result["manifest"]["coverageReport"]
        extension = next(
            item for item in report["unsupportedArtists"]
            if item.get("class") == "ggnewscale_or_renamed_aesthetic"
        )
        self.assertEqual(extension["package"], "ggnewscale")
        self.assertEqual(extension["status"], "shadow_unsupported")
        self.assertFalse(any(
            "ggnewscale" in json.dumps(obj.get("identity", {}), ensure_ascii=False).lower()
            and obj.get("editable")
            for obj in result["manifest"]["objects"]
        ))

    def test_coord_sf_text_position_is_diagnosed_and_rejected_without_partial_style_apply(self):
        source = read_synthetic_fixture("r/coord_sf_shadow.R")
        result = _run_r_renderer(source)
        text_obj = next(
            obj for obj in result["manifest"]["objects"]
            if obj.get("role") == "ggplot_text_data"
        )
        self.assertNotIn("position", text_obj["editable"])
        self.assertEqual(text_obj["currentProps"]["positionCoordinateClass"], "CoordSf")
        self.assertEqual(text_obj["currentProps"]["positionAdapterStatus"], "shadow_unsupported")
        edits = [
            _backend_patch(text_obj, "color", "#00AA00"),
            _backend_patch(text_obj, "position", {"x": 1.5, "y": 1.5, "coord_system": "data"}),
        ]
        rejected = _run_r_renderer(source, edits)
        self.assertTrue(rejected["conflict"], rejected)
        self.assertEqual(rejected["applied"], [], rejected)
        self.assertEqual(len(rejected["skipped"]), len(edits), rejected)
        replayed_text = _object(rejected, text_obj["id"])
        self.assertEqual(
            replayed_text["currentProps"]["color"],
            text_obj["currentProps"]["color"],
            rejected,
        )

    def test_ggraph_named_geoms_do_not_gain_diagram_semantics_without_explicit_markers(self):
        source = read_synthetic_fixture("r/ggraph_shadow.R")
        result = _run_r_renderer(source)
        objects = [
            obj for obj in result["manifest"]["objects"]
            if obj.get("source", {}).get("artistClass") in {"GeomNodePoint", "GeomEdgePath"}
        ]
        self.assertEqual(len(objects), 2, objects)
        self.assertFalse(any(str(obj.get("role", "")).startswith("diagram_") for obj in objects))
        for obj in objects:
            self.assertEqual(obj["kind"], "unsupported")
            self.assertEqual(obj["editable"], [])
            self.assertEqual(obj["currentProps"]["extensionPackage"], "ggraph")
            self.assertEqual(obj["currentProps"]["extensionSupport"], "shadow_unsupported")

    def test_base_r_remains_preview_only_and_rejects_object_patch(self):
        source = read_synthetic_fixture("r/base_r_preview.R")
        result = _run_r_renderer(source, [{"gid": "r.layer.0", "prop": "color", "value": "#00AA00"}])
        self.assertTrue(result["conflict"], result)
        self.assertEqual(result["applied"], [], result)
        self.assertEqual(result["manifest"]["objects"], [])
        self.assertFalse(result["manifest"]["capabilities"]["backendPatch"])

    def test_missing_extension_packages_return_structured_diagnostics(self):
        package = "scifigureWp8DefinitelyMissingPackage"
        result = _run_r_renderer_raw(f'library("{package}")')
        self.assertEqual(result["status"], "error", result)
        self.assertEqual(result["diagnostic"]["category"], "missing_package", result)
        self.assertEqual(result["diagnostic"]["details"]["package"], package, result)
        public_inventory = result["runtimeInventory"]
        for private_key in (
            "executable",
            "libraryPaths",
            "environment",
            "workingDirectory",
            "temporaryDirectory",
            "fonts",
        ):
            self.assertNotIn(private_key, public_inventory, result)
        self.assertNotIn("home", public_inventory.get("r", {}), result)


if __name__ == "__main__":
    unittest.main()

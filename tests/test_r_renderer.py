import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Dict, List


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R_RENDERER = os.path.join(PROJECT_ROOT, "renderer", "r_renderer.R")


def _rscript_bin() -> str:
    return (
        os.environ.get("RSCRIPT_BIN")
        or os.environ.get("R_BIN")
        or r"C:\Users\SZC\.conda\envs\Machine-learning\Scripts\Rscript.exe"
        if os.name == "nt"
        else "Rscript"
    )


def _process_env() -> dict:
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
    return env


def _run_r_renderer(script: str, edit_log=None, render_options=None, extra_payload=None) -> Dict[str, Any]:
    payload = {
        "script": script,
        "editLog": edit_log or [],
        "renderOptions": render_options or {"width_in": 6, "height_in": 4},
    }
    if extra_payload:
        payload.update(extra_payload)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        payload_file = f.name

    try:
        proc = subprocess.run(
            [_rscript_bin(), R_RENDERER, "--payload-file", payload_file],
            cwd=PROJECT_ROOT,
            env=_process_env(),
            text=True,
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
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"R renderer did not return JSON. code={proc.returncode} stdout={stdout[:500]} stderr={proc.stderr}") from exc
    if result.get("status") != "success":
        raise AssertionError(f"R renderer failed: {result}")
    return result


def _objects(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    return result["manifest"]["objects"]


def _object(result: Dict[str, Any], gid: str) -> Dict[str, Any]:
    return next(obj for obj in _objects(result) if obj["id"] == gid)


@unittest.skipUnless(os.path.exists(_rscript_bin()), "Rscript is not available")
class TestRRenderer(unittest.TestCase):
    def test_text_theme_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic() + labs(title="Old", x="X", y="Y")
p
"""
        result = _run_r_renderer(script, [
            {"gid": "title.0", "prop": "text", "value": "Updated title", "mode": "backend_patch"},
            {"gid": "title.0", "prop": "fontsize", "value": 18, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_labelsize", "value": 14, "mode": "backend_patch"},
        ])
        self.assertIn("Updated title", result["svg"])
        self.assertEqual(_object(result, "title.0")["currentProps"]["fontsize"], 18)
        self.assertEqual(_object(result, "axis.x.0")["currentProps"]["tick_labelsize"], 14)

    def test_r_individual_tick_objects_are_readonly_but_axis_tick_style_is_editable(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B", "C"), y=c(1, 3, 2))
p <- ggplot(df, aes(x, y)) + geom_col() + theme_classic()
p
"""
        result = _run_r_renderer(script)
        xtick = _object(result, "xtick.0.0")
        ytick = _object(result, "ytick.0.0")
        axis_x = _object(result, "axis.x.0")
        axis_y = _object(result, "axis.y.0")

        self.assertEqual(xtick["editable"], [])
        self.assertEqual(ytick["editable"], [])
        self.assertIn("tick_labelcolor", axis_x["editable"])
        self.assertIn("tick_labelcolor", axis_y["editable"])

    def test_layer_style_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + geom_line() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "linewidth", "value": 3, "mode": "backend_patch"},
        ])
        self.assertIn('data-fig-id="r.layer.0"', result["svg"])
        self.assertIn('data-fig-id="r.layer.1"', result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "r.layer.1")["currentProps"]["linewidth"], 3)

    def test_manual_scale_palette_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1,4,2,6,3,7), group=rep(c("A","B"),3))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.group.color.0.1", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        palettes = result["manifest"]["palettes"]
        self.assertEqual(len(palettes), 2)
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "r.group.color.0.1")["currentProps"]["color"], "#2CA02C")

    def test_facet_manifest_and_strip_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:8, y=1:8, facet=rep(c("F1","F2"), each=4))
p <- ggplot(df, aes(x,y)) + geom_point() + facet_wrap(~facet) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "facet.strip.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "facet.strip.0", "prop": "fontsize", "value": 16, "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "facet.strip.0")["currentProps"]["fontsize"], 16)

    def test_heatmap_colorbar_patch(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:4, y=1:3)
df$z <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x, y, fill=z)) +
  geom_tile() +
  scale_fill_gradient(low="#132B43", high="#56B1F7", limits=c(0, 2), name="Intensity") +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.heatmap.fill.0", "prop": "cmap", "value": "inferno", "mode": "backend_patch"},
            {"gid": "r.heatmap.fill.0", "prop": "vmin", "value": 0.2, "mode": "backend_patch"},
            {"gid": "r.heatmap.fill.0", "prop": "vmax", "value": 1.1, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "label", "value": "Updated intensity", "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "tick_fontsize", "value": 15, "mode": "backend_patch"},
        ])
        heatmaps = [obj for obj in _objects(result) if obj["kind"] == "heatmap"]
        colorbars = [obj for obj in _objects(result) if obj["kind"] == "colorbar"]
        self.assertEqual(len(heatmaps), 1)
        self.assertEqual(len(colorbars), 1)
        self.assertIn("Updated intensity", result["svg"])
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["cmap"], "inferno")
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["vmin"], 0.2)
        self.assertEqual(_object(result, "r.colorbar.fill.0")["currentProps"]["tick_fontsize"], 15)

    def test_text_annotation_position_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y)) +
  geom_point() +
  geom_text(aes(label=label), color="#D62728", size=4) +
  annotate("text", x=2, y=4.5, label="Note", color="#1F78B4", size=5) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.1.0", "prop": "text", "value": "Alpha", "mode": "backend_patch"},
            {"gid": "r.text.1.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.text.1.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_objects = [obj for obj in _objects(result) if obj["id"].startswith("r.text.")]
        self.assertEqual(len(text_objects), 4)
        text_obj = _object(result, "r.text.1.0")
        self.assertIn('id="r.text.1.0"', result["svg"])
        self.assertIn('id="r.text.2.0"', result["svg"])
        self.assertIn("Alpha", result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(text_obj["currentProps"]["text"], "Alpha")
        self.assertEqual(text_obj["currentProps"]["x"], 0.8)
        self.assertEqual(text_obj["currentProps"]["y"], 0.2)
        self.assertEqual(text_obj["currentProps"]["coord_system"], "axes")
        self.assertGreater(text_obj["currentProps"]["data_x"], 1)
        self.assertLess(text_obj["currentProps"]["data_y"], 4)

    def test_text_position_disabled_for_coord_flip(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text(color="#D62728", size=4) +
  coord_flip() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
            {"gid": "r.text.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn('id="r.text.0.0"', result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertNotIn("position", text_obj["editable"])
        self.assertNotIn("x", text_obj["currentProps"])
        self.assertNotIn("y", text_obj["currentProps"])
        self.assertFalse(text_obj["currentProps"]["positionEditable"])
        self.assertIn("CoordFlip", text_obj["currentProps"]["positionUnsupportedReason"])
        self.assertTrue(any("CoordFlip" in warning for warning in result.get("warnings", [])))

    def test_text_position_disabled_for_log_position_scale(self):
        script = """
library(ggplot2)
df <- data.frame(x=c(1, 10, 100), y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text(color="#D62728", size=4) +
  scale_x_log10() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertNotIn("position", text_obj["editable"])
        self.assertNotIn("x", text_obj["currentProps"])
        self.assertNotIn("y", text_obj["currentProps"])
        self.assertFalse(text_obj["currentProps"]["positionEditable"])
        self.assertIn("scale", text_obj["currentProps"]["positionUnsupportedReason"])
        self.assertTrue(any("scale" in warning for warning in result.get("warnings", [])))

    def test_uploaded_csv_json_bridge_preserves_quoted_commas_and_unicode_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar_path = os.path.join(tmp, "analysis.csv.scifigure-table.json")
            with open(sidecar_path, "w", encoding="utf-8") as f:
                json.dump({
                    "columns": ["地点（经纬度）", "reservoir_water_TP_mg_L", "cluster_type"],
                    "rows": [
                        {"地点（经纬度）": "30.82°N,111.00°E", "reservoir_water_TP_mg_L": 0.0229, "cluster_type": "Type I"},
                        {"地点（经纬度）": "36.25°N, 114.39°W", "reservoir_water_TP_mg_L": 0.125, "cluster_type": "Type II"},
                    ],
                }, f, ensure_ascii=False)
            script = """
library(ggplot2)
df <- read.csv(uploaded_file_paths[["analysis.csv"]], check.names = FALSE)
p <- ggplot(df, aes(x = cluster_type, y = reservoir_water_TP_mg_L, fill = cluster_type)) +
  geom_col() +
  labs(x = "Reservoir type", y = "TP") +
  theme_classic()
p
"""
            result = _run_r_renderer(script, extra_payload={
                "cwd": tmp,
                "uploaded_file_paths": {"analysis.csv": "analysis.csv"},
                "csv_json_paths": {"analysis.csv": "analysis.csv.scifigure-table.json"},
            })
            self.assertIn("Reservoir type", result["svg"])
            self.assertIn("Type I", result["svg"])
            self.assertEqual(result["status"], "success")

    def test_aligned_theme_details_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            # Ticks/Axes limits/rotation/direction/width/color/pad
            {"gid": "axis.x.0", "prop": "tick_rotation", "value": 45, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_direction", "value": "in", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_length", "value": 8.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_width", "value": 2.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_color", "value": "#FF0000", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_pad", "value": 10.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "limits", "value": [0, 10], "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_fontweight", "value": "bold", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_fontstyle", "value": "italic", "mode": "backend_patch"},

            # Legend visible/loc/facecolor/edgecolor/linewidth
            {"gid": "legend.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "loc", "value": "bottom", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "facecolor", "value": "#00FF00", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "edgecolor", "value": "#0000FF", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "linewidth", "value": 1.5, "mode": "backend_patch"},

            # Spine visibility/color/linewidth
            {"gid": "spine.bottom.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "spine.bottom.0", "prop": "color", "value": "#FF00FF", "mode": "backend_patch"},
            {"gid": "spine.bottom.0", "prop": "linewidth", "value": 2.5, "mode": "backend_patch"},

            # Grid visibility/color/linewidth/linestyle
            {"gid": "grid.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "color", "value": "#FFFF00", "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "linewidth", "value": 1.2, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "linestyle", "value": "dashed", "mode": "backend_patch"},
        ])
        
        # Verify currentProps in manifest
        axis_x = _object(result, "axis.x.0")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 45)
        self.assertEqual(axis_x["currentProps"]["tick_direction"], "in")
        self.assertEqual(axis_x["currentProps"]["tick_length"], 8.0)
        self.assertEqual(axis_x["currentProps"]["tick_width"], 2.0)
        self.assertEqual(axis_x["currentProps"]["tick_color"], "#FF0000")
        self.assertEqual(axis_x["currentProps"]["tick_pad"], 10.0)
        self.assertEqual(axis_x["currentProps"]["limits"], [0, 10])
        self.assertEqual(axis_x["currentProps"]["tick_fontweight"], "bold")
        self.assertEqual(axis_x["currentProps"]["tick_fontstyle"], "italic")

        legend = _object(result, "legend.0")
        self.assertEqual(legend["currentProps"]["visible"], True)
        self.assertEqual(legend["currentProps"]["loc"], "bottom")
        self.assertEqual(legend["currentProps"]["facecolor"], "#00FF00")
        self.assertEqual(legend["currentProps"]["edgecolor"], "#0000FF")
        self.assertEqual(legend["currentProps"]["linewidth"], 1.5)

        spine_b = _object(result, "spine.bottom.0")
        self.assertEqual(spine_b["currentProps"]["visible"], True)
        self.assertEqual(spine_b["currentProps"]["color"], "#FF00FF")
        self.assertEqual(spine_b["currentProps"]["linewidth"], 2.5)

        grid = _object(result, "grid.0")
        self.assertEqual(grid["currentProps"]["visible"], True)
        self.assertEqual(grid["currentProps"]["color"], "#FFFF00")
        self.assertEqual(grid["currentProps"]["linewidth"], 1.2)
        self.assertEqual(grid["currentProps"]["linestyle"], "dashed")

    def test_r_axis_manifest_reports_initial_limits(self):
        script = """
library(ggplot2)
df <- data.frame(x=c(2, 4, 8), y=c(10, 20, 40))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
"""
        result = _run_r_renderer(script)
        x_limits = _object(result, "axis.x.0")["currentProps"]["limits"]
        y_limits = _object(result, "axis.y.0")["currentProps"]["limits"]

        self.assertIsInstance(x_limits, list)
        self.assertIsInstance(y_limits, list)
        self.assertEqual(len(x_limits), 2)
        self.assertEqual(len(y_limits), 2)
        self.assertLessEqual(x_limits[0], 2)
        self.assertGreaterEqual(x_limits[1], 8)
        self.assertLessEqual(y_limits[0], 10)
        self.assertGreaterEqual(y_limits[1], 40)

    def test_r_grid_and_legend_alpha_patch_changes_svg_output(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=3) +
  theme_bw()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "grid.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "color", "value": "#FF0000", "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "alpha", "value": 0.25, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "facecolor", "value": "#00FF00", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "edgecolor", "value": "#0000FF", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "alpha", "value": 0.35, "mode": "backend_patch"},
        ])
        svg = result["svg"].lower()
        self.assertIn("#ff0000", svg)
        self.assertIn("#00ff00", svg)
        self.assertIn("#0000ff", svg)
        self.assertTrue("stroke-opacity: 0.25" in svg or "stroke-opacity=\"0.25\"" in svg)
        self.assertTrue("fill-opacity: 0.35" in svg or "fill-opacity=\"0.35\"" in svg)


if __name__ == "__main__":
    unittest.main()

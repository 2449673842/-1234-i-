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
    def test_r_shadow_identity_is_stable_across_style_edits(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_line() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#CC0000", "mode": "backend_patch"},
        ])
        baseline_objects = _objects(baseline)
        instance_keys = [obj["identity"]["instanceKey"] for obj in baseline_objects]
        self.assertEqual(len(instance_keys), len(set(instance_keys)))
        for obj in baseline_objects:
            capability_props = [item["prop"] for item in obj["propertyCapabilities"]]
            self.assertEqual(sorted(obj["editable"]), sorted(capability_props))
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertEqual(
            baseline_layer["identity"]["instanceKey"],
            patched_layer["identity"]["instanceKey"],
        )
        self.assertEqual(
            baseline_layer["identity"]["semanticKey"],
            patched_layer["identity"]["semanticKey"],
        )
        self.assertEqual(
            baseline_layer["identity"]["seriesKey"],
            patched_layer["identity"]["seriesKey"],
        )
        color_capability = next(
            capability for capability in patched_layer["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertEqual(color_capability["patchMode"], "backend_patch")
        self.assertEqual(color_capability["replay"], "stable")
        self.assertIn("object", color_capability["scopes"])
        self.assertIn("cross_figure", color_capability["scopes"])

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

    def test_r_individual_tick_objects_are_style_editable(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B", "C"), y=c(1, 3, 2))
p <- ggplot(df, aes(x, y)) + geom_col() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "xtick.0.0", "prop": "fontsize", "value": 13, "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontweight", "value": "bold", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontstyle", "value": "italic", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "rotation", "value": 35, "mode": "backend_patch"},
        ])
        xtick = _object(result, "xtick.0.0")
        ytick = _object(result, "ytick.0.0")
        axis_x = _object(result, "axis.x.0")
        axis_y = _object(result, "axis.y.0")

        self.assertIn("fontsize", xtick["editable"])
        self.assertIn("fontfamily", xtick["editable"])
        self.assertIn("color", xtick["editable"])
        self.assertIn("rotation", xtick["editable"])
        self.assertIn("fontsize", ytick["editable"])
        self.assertEqual(xtick["currentProps"]["fontsize"], 13)
        self.assertEqual(xtick["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(xtick["currentProps"]["fontweight"], "bold")
        self.assertEqual(xtick["currentProps"]["fontstyle"], "italic")
        self.assertEqual(xtick["currentProps"]["color"], "#AA0000")
        self.assertEqual(xtick["currentProps"]["rotation"], 35)
        # ggplot applies tick text styling at the axis theme level.
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 13)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "Times New Roman")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "#AA0000")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 35)
        self.assertIn("tick_labelcolor", axis_x["editable"])
        self.assertIn("tick_labelcolor", axis_y["editable"])

    def test_axis_label_and_tick_style_are_separate(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic() + labs(x="Old X", y="Old Y")
p
"""
        result = _run_r_renderer(script, [
            {"gid": "axis.y.0", "prop": "label", "value": "Updated Y", "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "label_color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "label_fontsize", "value": 17, "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "tick_labelcolor", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        axis_y = _object(result, "axis.y.0")
        ylabel = _object(result, "ylabel.0")

        self.assertEqual(axis_y["currentProps"]["label"], "Updated Y")
        self.assertEqual(axis_y["currentProps"]["label_color"], "#AA0000")
        self.assertEqual(axis_y["currentProps"]["label_fontsize"], 17)
        self.assertEqual(axis_y["currentProps"]["tick_labelcolor"], "#2CA02C")
        self.assertEqual(ylabel["currentProps"]["text"], "Updated Y")
        self.assertEqual(ylabel["currentProps"]["color"], "#AA0000")
        self.assertIn("Updated Y", result["svg"])

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
        bindings = result["manifest"]["bindings"]
        self.assertEqual(len(palettes), 2)
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "r.group.color.0.1")["currentProps"]["color"], "#2CA02C")
        target_binding = next(binding for binding in bindings if binding["paletteId"] == "r.scale.color.0.1")
        self.assertEqual(target_binding["targetMode"], "exact")
        self.assertEqual(target_binding["targets"], [{
            "gid": "r.group.color.0.1",
            "prop": "color",
            "instanceKey": "r:container:r.group.color.0.1",
            "seriesKey": "r-series:color:B",
            "match": "scale_key",
            "confidence": "exact",
        }])

    def test_default_discrete_scale_exposes_layer_group_panel_aesthetic_identity(self):
        script = """
library(ggplot2)
df <- expand.grid(panel=c("P1", "P2"), group=c("A", "B"), x=1:2)
df$y <- seq_len(nrow(df))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  facet_wrap(~panel) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.group.color.0.1", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])

        group_a = _object(baseline, "r.group.color.0.0")
        group_b = _object(baseline, "r.group.color.0.1")
        relation = group_b["identity"]["relation"]
        self.assertEqual(relation["aesthetic"], "color")
        self.assertEqual(relation["groupKey"], "B")
        self.assertEqual(relation["scaleId"], "r.scale.color.0")
        self.assertEqual(relation["guideId"], "legend.0")
        self.assertEqual(relation["legendId"], "legend.0")
        self.assertEqual(relation["layerIds"], ["r.layer.0"])
        self.assertEqual(relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertEqual(group_b["identity"]["semanticKey"], "ggplot_group:color:B")
        self.assertEqual(group_b["identity"]["seriesKey"], "r-series:color:B")
        self.assertTrue(group_b["currentProps"]["svgSelectable"])
        color_capability = next(
            capability for capability in group_b["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertNotIn("subplot", color_capability["scopes"])
        self.assertIn("figure", color_capability["scopes"])
        self.assertIn('data-fig-id="r.group.color.0.0"', baseline["svg"])
        self.assertIn('data-fig-id="r.group.color.0.1"', baseline["svg"])

        patched_a = _object(patched, "r.group.color.0.0")
        patched_b = _object(patched, "r.group.color.0.1")
        self.assertEqual(patched_a["currentProps"]["color"], group_a["currentProps"]["color"])
        self.assertEqual(patched_b["currentProps"]["color"], "#2CA02C")
        self.assertEqual(patched_b["identity"]["semanticKey"], group_b["identity"]["semanticKey"])
        self.assertIn("#2CA02C".lower(), patched["svg"].lower())

        layer_relation = _object(baseline, "r.layer.0")["identity"]["relation"]
        self.assertEqual(
            layer_relation["groupIds"],
            ["r.group.color.0.0", "r.group.color.0.1"],
        )
        self.assertEqual(layer_relation["subplotIds"], ["subplot.0", "subplot.1"])

    def test_duplicate_discrete_colors_do_not_guess_svg_group_identity(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#777777", B="#777777")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        group_a = _object(result, "r.group.color.0.0")
        group_b = _object(result, "r.group.color.0.1")
        self.assertFalse(group_a["currentProps"]["svgSelectable"])
        self.assertFalse(group_b["currentProps"]["svgSelectable"])
        self.assertNotIn('data-fig-id="r.group.color.0.0"', result["svg"])
        self.assertNotIn('data-fig-id="r.group.color.0.1"', result["svg"])
        self.assertIn('data-fig-id="r.layer.0"', result["svg"])

    def test_discrete_group_patch_preserves_scale_order_labels_and_title(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "B", "A", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  scale_color_discrete(
    limits=c("B", "A"),
    breaks=c("B", "A"),
    labels=c(B="Beta", A="Alpha"),
    name="Study group",
    na.value="#123456",
    drop=FALSE
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.group.color.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        baseline_groups = baseline["manifest"]["groups"]
        patched_groups = patched["manifest"]["groups"]
        self.assertEqual([group["label"] for group in baseline_groups], ["Beta", "Alpha"])
        self.assertEqual([group["label"] for group in patched_groups], ["Beta", "Alpha"])
        self.assertEqual(_object(patched, "legend.0")["currentProps"]["title"], "Study group")
        self.assertEqual(_object(patched, "r.group.color.0.0")["currentProps"]["groupKey"], "B")
        self.assertEqual(_object(patched, "r.group.color.0.0")["currentProps"]["color"], "#2CA02C")

    def test_legend_title_and_item_text_manifest(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1,4,2,6,3,7), group=rep(c("A","B"),3))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "legend_title.0", "prop": "text", "value": "Updated group", "mode": "backend_patch"},
            {"gid": "legend_title.0", "prop": "fontsize", "value": 14, "mode": "backend_patch"},
            {"gid": "legend_title.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "text", "value": "Alpha group", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "fontsize", "value": 11, "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        legend_title = _object(result, "legend_title.0")
        legend_text = _object(result, "legend_text.0.0")
        legend = _object(result, "legend.0")

        self.assertEqual(legend["currentProps"]["title"], "Updated group")
        self.assertEqual(legend_title["currentProps"]["text"], "Updated group")
        self.assertEqual(legend_title["currentProps"]["fontsize"], 14)
        self.assertEqual(legend_title["currentProps"]["color"], "#AA0000")
        self.assertEqual(legend_text["kind"], "text")
        self.assertEqual(legend_text["role"], "legend_text")
        self.assertEqual(legend_text["currentProps"]["text"], "Alpha group")
        self.assertEqual(legend_text["currentProps"]["fontsize"], 11)
        self.assertEqual(legend_text["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(legend_text["currentProps"]["color"], "#2CA02C")
        self.assertIn("text", legend_text["editable"])
        self.assertIn("Updated group", result["svg"])
        self.assertIn("Alpha group", result["svg"])

    def test_boxplot_and_violin_layers_are_semantic_containers(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1:10, 3:12))
p <- ggplot(df, aes(group, value, fill=group)) +
  geom_boxplot(alpha=0.7) +
  geom_violin(alpha=0.3) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "box_color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "median_color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "facecolor", "value": "#9467BD", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "edgecolor", "value": "#111111", "mode": "backend_patch"},
        ])
        box = _object(result, "r.layer.0")
        violin = _object(result, "r.layer.1")

        self.assertEqual(box["kind"], "boxplot_container")
        self.assertIn("box_color", box["editable"])
        self.assertIn("median_color", box["editable"])
        self.assertEqual(box["currentProps"]["box_color"], "#2CA02C")
        self.assertEqual(box["currentProps"]["median_color"], "#AA0000")
        self.assertEqual(box["currentProps"]["linewidth"], 2)
        self.assertEqual(violin["kind"], "violinplot_container")
        self.assertIn("facecolor", violin["editable"])
        self.assertEqual(violin["currentProps"]["facecolor"], "#9467BD")
        self.assertEqual(violin["currentProps"]["edgecolor"], "#111111")

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
            {"gid": "subplot.1", "prop": "aspect", "value": "1", "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)
        self.assertIn("aspect", subplots[0]["editable"])
        self.assertEqual(subplots[0]["currentProps"]["aspect"], 1)
        self.assertEqual(subplots[1]["currentProps"]["aspect"], 1)
        self.assertIn("left", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("width", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "facet.strip.0")["currentProps"]["fontsize"], 16)

    def test_facet_non_first_panel_tick_edits_apply_to_global_axis_theme(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(c("A", "B", "C"), 2),
  y=c(1, 3, 2, 2, 4, 3),
  facet=rep(c("F1","F2"), each=3)
)
p <- ggplot(df, aes(x,y)) + geom_col() + facet_wrap(~facet) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "xtick.1.0", "prop": "fontsize", "value": 15, "mode": "backend_patch"},
            {"gid": "xtick.1.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "xtick.1.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "axis.x.1", "prop": "tick_rotation", "value": 30, "mode": "backend_patch"},
            {"gid": "axis.x.1", "prop": "tick_direction", "value": "in", "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)

        xtick = _object(result, "xtick.1.0")
        axis_x = _object(result, "axis.x.0")
        self.assertEqual(xtick["currentProps"]["fontsize"], 15)
        self.assertEqual(xtick["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(xtick["currentProps"]["color"], "#AA0000")
        # ggplot applies facet tick styling through the global axis theme.
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 15)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "Times New Roman")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "#AA0000")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 30)
        self.assertEqual(axis_x["currentProps"]["tick_direction"], "in")

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
            {"gid": "r.colorbar.fill.0", "prop": "left", "value": 0.72, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "bottom", "value": 0.18, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "width", "value": 0.08, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "height", "value": 0.45, "mode": "backend_patch"},
        ])
        heatmaps = [obj for obj in _objects(result) if obj["kind"] == "heatmap"]
        colorbars = [obj for obj in _objects(result) if obj["kind"] == "colorbar"]
        self.assertEqual(len(heatmaps), 1)
        self.assertEqual(len(colorbars), 1)
        self.assertIn("Updated intensity", result["svg"])
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["cmap"], "inferno")
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["vmin"], 0.2)
        colorbar = _object(result, "r.colorbar.fill.0")
        self.assertEqual(colorbar["currentProps"]["tick_fontsize"], 15)
        heatmap = _object(result, "r.heatmap.fill.0")
        self.assertEqual(heatmap["identity"]["relation"]["colorbarId"], colorbar["id"])
        self.assertEqual(colorbar["identity"]["relation"]["mappableId"], heatmap["id"])
        self.assertEqual(colorbar["identity"]["relation"]["mappableIds"], [heatmap["id"]])
        self.assertEqual(heatmap["identity"]["relation"]["layerIds"], ["r.layer.0"])
        self.assertEqual(colorbar["identity"]["relation"]["layerIds"], ["r.layer.0"])
        self.assertEqual(heatmap["identity"]["relation"]["subplotIds"], ["subplot.0"])
        self.assertEqual(colorbar["identity"]["relation"]["subplotIds"], ["subplot.0"])
        self.assertEqual(heatmap["identity"]["relation"]["scaleId"], "r.scale.fill.continuous.0")
        self.assertEqual(colorbar["identity"]["relation"]["scaleId"], "r.scale.fill.continuous.0")
        self.assertEqual(heatmap["identity"]["relation"]["guideId"], colorbar["id"])
        self.assertIn("left", colorbar["editable"])
        self.assertIn("bottom", colorbar["editable"])
        self.assertIn("width", colorbar["editable"])
        self.assertIn("height", colorbar["editable"])
        self.assertEqual(colorbar["currentProps"]["left"], 0.72)
        self.assertEqual(colorbar["currentProps"]["bottom"], 0.18)
        self.assertEqual(colorbar["currentProps"]["width"], 0.08)
        self.assertEqual(colorbar["currentProps"]["height"], 0.45)

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
        self.assertEqual(text_obj["identity"]["relation"]["annotationId"], text_obj["id"])
        self.assertEqual(text_obj["identity"]["relation"]["layerId"], "r.layer.1")
        self.assertEqual(text_obj["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertEqual(text_obj["identity"]["relation"]["aesthetic"], "label")
        self.assertNotIn("arrowId", text_obj["identity"]["relation"])
        self.assertEqual(text_obj["currentProps"]["identityStability"], "conditional")
        self.assertTrue(all(
            capability["replay"] == "conditional"
            for capability in text_obj["propertyCapabilities"]
        ))
        self.assertGreater(text_obj["currentProps"]["data_x"], 1)
        self.assertLess(text_obj["currentProps"]["data_y"], 4)

    def test_text_data_key_survives_code_row_reordering(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b", "sample-c"),
  x=1:3,
  y=c(2,4,3),
  label=c("A","B","C")
)
p <- ggplot(df, aes(x,y,label=label)) + geom_text() + theme_classic()
p
"""
        reordered_script = baseline_script.replace(
            'p <- ggplot(df, aes(x,y,label=label))',
            'df <- df[c(3,1,2),]\np <- ggplot(df, aes(x,y,label=label))',
        )
        baseline = _run_r_renderer(baseline_script)
        sample_a = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("dataKey") == "sample-a"
        )
        result = _run_r_renderer(reordered_script, [
            {"gid": sample_a["id"], "prop": "text", "value": "Alpha", "mode": "backend_patch"},
            {"gid": sample_a["id"], "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        reordered_a = _object(result, sample_a["id"])
        sample_b = next(
            obj for obj in _objects(result)
            if obj.get("currentProps", {}).get("dataKey") == "sample-b"
        )

        self.assertEqual(reordered_a["currentProps"]["text"], "Alpha")
        self.assertEqual(reordered_a["currentProps"]["color"], "#2CA02C")
        self.assertEqual(reordered_a["currentProps"]["identityStability"], "stable")
        self.assertEqual(reordered_a["identity"]["instanceKey"], sample_a["identity"]["instanceKey"])
        self.assertEqual(reordered_a["identity"]["semanticKey"], sample_a["identity"]["semanticKey"])
        self.assertEqual(reordered_a["identity"]["relation"]["dataKey"], "sample-a")
        self.assertEqual(sample_b["currentProps"]["text"], "B")
        text_capability = next(
            capability for capability in reordered_a["propertyCapabilities"]
            if capability["prop"] == "text"
        )
        self.assertEqual(text_capability["replay"], "stable")

    def test_text_position_supported_for_coord_flip(self):
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
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.8, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.2, places=5)
        self.assertNotIn("positionEditable", text_obj["currentProps"])
        self.assertFalse(any("CoordFlip" in warning for warning in result.get("warnings", [])))

    def test_text_position_supported_for_x_log_scale(self):
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
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.7, "y": 0.3, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.7, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.3, places=5)
        self.assertGreater(text_obj["currentProps"]["data_x"], 10)
        self.assertAlmostEqual(_object(result, "r.text.0.1")["currentProps"]["data_x"], 10, places=5)
        self.assertAlmostEqual(_object(result, "r.text.0.2")["currentProps"]["data_x"], 100, places=5)
        self.assertFalse(any("scale" in warning for warning in result.get("warnings", [])))

    def test_text_position_supported_for_y_log_scale(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(1, 10, 100), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text() +
  scale_y_log10() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.8, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.2, places=5)
        self.assertGreater(text_obj["currentProps"]["data_y"], 1)

    def test_text_position_supported_inside_coord_polar_panel(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text() +
  coord_polar() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.7, "y": 0.3, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.7, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.3, places=5)

    def test_text_position_outside_coord_polar_panel_is_rejected(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) + geom_text() + coord_polar() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.99, "y": 0.99, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        baseline_text = _object(baseline, "r.text.0.0")
        text_obj = _object(result, "r.text.0.0")
        self.assertAlmostEqual(text_obj["currentProps"]["x"], baseline_text["currentProps"]["x"], places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], baseline_text["currentProps"]["y"], places=5)
        self.assertTrue(any("could not be inverted" in warning for warning in result.get("warnings", [])))

    def test_base_r_output_is_explicitly_unsupported_for_semantic_editing(self):
        result = _run_r_renderer('plot(1:3, 1:3, main="Base R preview")')
        report = result["manifest"]["coverageReport"]
        self.assertEqual(result["manifest"]["objects"], [])
        self.assertEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(report["unsupportedArtists"][0]["class"], "base_r_or_grid_output")
        self.assertFalse(result["manifest"]["capabilities"]["backendPatch"])
        self.assertIn("Base R preview", result["svg"])

    def test_unknown_ggplot_geom_is_readonly_and_explicitly_unsupported(self):
        script = """
library(ggplot2)
GeomCustomPoint <- ggproto("GeomCustomPoint", GeomPoint)
geom_custom_point <- function(mapping=NULL, data=NULL, ...) {
  layer(
    geom=GeomCustomPoint,
    mapping=mapping,
    data=data,
    stat="identity",
    position="identity",
    inherit.aes=TRUE,
    params=list(...)
  )
}
df <- data.frame(x=1:3, y=c(2,4,3))
p <- ggplot(df, aes(x,y)) + geom_custom_point(size=4) + theme_classic()
p
"""
        result = _run_r_renderer(script)
        layer = _object(result, "r.layer.0")
        report = result["manifest"]["coverageReport"]
        self.assertEqual(layer["kind"], "unsupported")
        self.assertEqual(layer["editable"], [])
        self.assertIn("GeomCustomPoint", layer["currentProps"]["unsupportedReason"])
        self.assertEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(report["unsupportedArtists"][0]["class"], "GeomCustomPoint")
        self.assertTrue(result["svg"])

    def test_renamed_multi_scale_aesthetic_is_reported_without_unsafe_merge(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_discrete() +
  theme_classic()
p$scales$scales[[1]]$aesthetics <- "colour_ggnewscale_1"
p
"""
        result = _run_r_renderer(script)
        report = result["manifest"]["coverageReport"]
        extension = next(
            item for item in report["unsupportedArtists"]
            if item["class"] == "ggnewscale_or_renamed_aesthetic"
        )
        self.assertGreaterEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(extension["count"], 1)
        self.assertTrue(result["svg"])

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
            {"gid": "legend.0", "prop": "ncol", "value": 2, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "markerscale", "value": 1.8, "mode": "backend_patch"},
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
        self.assertEqual(legend["currentProps"]["ncol"], 2)
        self.assertEqual(legend["currentProps"]["markerscale"], 1.8)
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

    def test_r_renderer_reports_monotonic_timing_breakdown(self):
        result = _run_r_renderer("""
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
""")
        self.assertEqual(result.get("status"), "success")
        timing = result.get("timingBreakdown", {})
        expected_keys = {
            "scriptExecutionMs",
            "svgSerializeMs",
            "manifestBuildMs",
            "svgPostprocessMs",
            "totalMs",
        }
        self.assertTrue(expected_keys.issubset(timing.keys()))
        self.assertTrue(all(isinstance(timing[key], (int, float)) and timing[key] >= 0 for key in expected_keys))
        self.assertEqual(result["timingMs"], timing["totalMs"])
        self.assertGreaterEqual(timing["totalMs"], timing["svgSerializeMs"])


if __name__ == "__main__":
    unittest.main()

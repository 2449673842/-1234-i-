import os
import sys
import json
import unittest

# Ensure the renderer directory is in the Python search path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render
from semantic_scanner import scan_source

class TestArtistIntrospection(unittest.TestCase):
    
    def test_dict_palette_ids_include_dict_name_to_avoid_cross_group_color_edits(self):
        script = """
import matplotlib.pyplot as plt
CLUSTER_COLORS = {"Weak": "#11aa33", "Mixed": "#aa3311"}
LEGEND_COLORS = {"Weak": "#eeeeee", "Mixed": "#333333"}
fig, ax = plt.subplots()
ax.plot([1, 2], [1, 2], color=CLUSTER_COLORS["Weak"], label="Weak")
"""
        semantic = scan_source(script)
        palette_ids = {palette["id"] for palette in semantic["palettes"]}
        self.assertIn("dict_CLUSTER_COLORS__Weak", palette_ids)
        self.assertIn("dict_LEGEND_COLORS__Weak", palette_ids)
        self.assertIn("dict_CLUSTER_COLORS__Mixed", palette_ids)
        self.assertIn("dict_LEGEND_COLORS__Mixed", palette_ids)
        weak_group = next(group for group in semantic["groups"] if group["label"] == "Weak")
        self.assertEqual(weak_group["paletteId"], "dict_CLUSTER_COLORS__Weak")

    
    def test_replay_render_captures_more_than_three_figures(self):
        script = """
import matplotlib.pyplot as plt
for i in range(5):
    fig, ax = plt.subplots()
    ax.plot([0, 1, 2], [i, i + 1, i + 2])
    ax.set_title(f"Figure {i + 1}")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 5)
        self.assertEqual([fig.get("figureId") for fig in figures], ["fig_1", "fig_2", "fig_3", "fig_4", "fig_5"])

    def test_bar_container_introspection(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
x = ['A', 'B', 'C']
y = [10, 20, 15]
ax.bar(x, y, label="sales")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 1)
        
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        # Verify containers
        bar_containers = [o for o in objects if o["kind"] == "bar_container"]
        self.assertEqual(len(bar_containers), 1)
        
        container = bar_containers[0]
        self.assertEqual(container["role"], "bar_series")
        self.assertTrue(len(container.get("children", [])) > 0)
        self.assertTrue(container.get("stableKey").startswith("ax0.bar_container"))
        
        # Verify children parentId link
        child_id = container["children"][0]
        child_obj = next(o for o in objects if o["id"] == child_id)
        self.assertEqual(child_obj["parentId"], container["id"])
        self.assertEqual(child_obj["role"], "bar_series")
        
    def test_errorbar_container_introspection(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
x = [1, 2, 3]
y = [10, 20, 15]
yerr = [1, 2, 1.5]
ax.errorbar(x, y, yerr=yerr, fmt='o-', label="growth")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 1)
        
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        # Verify containers
        eb_containers = [o for o in objects if o["kind"] == "errorbar_container"]
        self.assertEqual(len(eb_containers), 1)
        
        container = eb_containers[0]
        self.assertEqual(container["role"], "errorbar_series")
        self.assertTrue(len(container.get("children", [])) > 0)
        
        # Verify children parentId link
        child_id = container["children"][0]
        child_obj = next(o for o in objects if o["id"] == child_id)
        self.assertEqual(child_obj["parentId"], container["id"])
        self.assertEqual(child_obj["role"], "errorbar_series")

    def test_coverage_report_details(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2], [3, 4])
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        report = manifest.get("coverageReport", {})
        
        self.assertIn("summary", report)
        self.assertTrue(report["summary"]["recognized"] > 0)
        self.assertIn("byKind", report)
        self.assertIn("unsupportedArtists", report)

    def test_boxplot_container_introspection(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.boxplot([[1, 2, 3], [2, 3, 4]])
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 1)
        
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        # Verify boxplot containers
        bp_containers = [o for o in objects if o["kind"] == "boxplot_container"]
        self.assertEqual(len(bp_containers), 1)
        
        container = bp_containers[0]
        self.assertEqual(container["role"], "boxplot_group")
        self.assertTrue(len(container.get("children", [])) > 0)
        
        # Verify child links
        child_id = container["children"][0]
        child_obj = next(o for o in objects if o["id"] == child_id)
        self.assertEqual(child_obj["parentId"], container["id"])
        self.assertEqual(child_obj["role"], "boxplot_group")

    def test_boxplot_patch_artist_pathpatch_introspection(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.boxplot(
    [[1, 2, 3], [2, 3, 4]],
    patch_artist=True,
    boxprops=dict(facecolor="#3366cc", edgecolor="#111111", linewidth=1.2),
    medianprops=dict(color="#cc3300", linewidth=1.0),
)
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")

        objects = res["figures"][0]["manifest"]["objects"]
        container = next(o for o in objects if o["kind"] == "boxplot_container")

        self.assertEqual(container["role"], "boxplot_group")
        self.assertEqual(container["currentProps"]["color"].lower(), "#111111")
        self.assertEqual(container["currentProps"]["box_color"].lower(), "#3366cc")
        self.assertEqual(container["currentProps"]["median_color"].lower(), "#cc3300")

    def test_violinplot_container_introspection(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.violinplot([[1, 2, 3], [2, 3, 4]])
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 1)
        
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        # Verify violinplot containers
        vp_containers = [o for o in objects if o["kind"] == "violinplot_container"]
        self.assertEqual(len(vp_containers), 1)
        
        container = vp_containers[0]
        self.assertEqual(container["role"], "violin_group")
        self.assertTrue(len(container.get("children", [])) > 0)
        
        # Verify child links
        child_id = container["children"][0]
        child_obj = next(o for o in objects if o["id"] == child_id)
        self.assertEqual(child_obj["parentId"], container["id"])
        self.assertEqual(child_obj["role"], "violin_group")

    def test_heatmap_imshow_introspection(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
data = np.random.rand(8, 12)
ax.imshow(data, cmap="viridis", vmin=0.1, vmax=0.9, interpolation="nearest")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        self.assertEqual(len(figures), 1)
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        heatmaps = [o for o in objects if o["kind"] == "heatmap"]
        self.assertEqual(len(heatmaps), 1)
        
        hm = heatmaps[0]
        self.assertEqual(hm["role"], "heatmap_series")
        self.assertEqual(hm["currentProps"]["cmap"], "viridis")
        self.assertEqual(hm["currentProps"]["vmin"], 0.1)
        self.assertEqual(hm["currentProps"]["vmax"], 0.9)
        self.assertEqual(hm["currentProps"]["interpolation"], "nearest")
        self.assertEqual(hm["currentProps"]["shape"], [8, 12])
        self.assertEqual(len(hm["currentProps"]["extent"]), 4)

    def test_heatmap_pcolormesh_introspection(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
data = np.random.rand(8, 12)
ax.pcolormesh(data, cmap="plasma", vmin=0.2, vmax=0.8)
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        heatmaps = [o for o in objects if o["kind"] == "heatmap"]
        self.assertEqual(len(heatmaps), 1)
        
        hm = heatmaps[0]
        self.assertEqual(hm["role"], "heatmap_series")
        self.assertEqual(hm["currentProps"]["cmap"], "plasma")
        self.assertEqual(hm["currentProps"]["vmin"], 0.2)
        self.assertEqual(hm["currentProps"]["vmax"], 0.8)
        self.assertEqual(hm["currentProps"]["shape"], [8, 12])

    def test_colorbar_introspection(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
data = np.random.rand(8, 12)
im = ax.imshow(data, cmap="inferno")
fig.colorbar(im, ax=ax, orientation="vertical", label="Intensity")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        colorbars = [o for o in objects if o["kind"] == "colorbar"]
        self.assertEqual(len(colorbars), 1)
        
        cb = colorbars[0]
        self.assertEqual(cb["role"], "colorbar")
        self.assertEqual(cb["currentProps"]["label"], "Intensity")
        self.assertEqual(cb["currentProps"]["orientation"], "vertical")
        self.assertEqual(cb["currentProps"]["cmap"], "inferno")
        self.assertIsNotNone(cb["currentProps"]["vmin"])
        self.assertIsNotNone(cb["currentProps"]["vmax"])

    def test_raster_image_not_heatmap_introspection(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
# RGB image
data = np.zeros((8, 8, 3))
ax.imshow(data)
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        heatmaps = [o for o in objects if o["kind"] == "heatmap"]
        self.assertEqual(len(heatmaps), 1)
        
        hm = heatmaps[0]
        # Should gracefully handle None values for cmap and clim
        self.assertIsNone(hm["currentProps"]["cmap"])
        self.assertIsNone(hm["currentProps"]["vmin"])
        self.assertIsNone(hm["currentProps"]["vmax"])
        self.assertEqual(hm["currentProps"]["shape"], [8, 8, 3])

    def test_heatmap_patch_application(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
data = np.random.rand(8, 12)
ax.imshow(data, cmap="viridis", vmin=0.1, vmax=0.9)
"""
        edit_log = [
            {"gid": "heatmap.image.0.0", "prop": "cmap", "value": "inferno", "mode": "backend_patch"},
            {"gid": "heatmap.image.0.0", "prop": "vmin", "value": 0.3, "mode": "backend_patch"},
            {"gid": "heatmap.image.0.0", "prop": "vmax", "value": 0.7, "mode": "backend_patch"},
            {"gid": "heatmap.image.0.0", "prop": "alpha", "value": 0.5, "mode": "backend_patch"}
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        hm = next(o for o in objects if o["id"] == "heatmap.image.0.0")
        self.assertEqual(hm["currentProps"]["cmap"], "inferno")
        self.assertEqual(hm["currentProps"]["vmin"], 0.3)
        self.assertEqual(hm["currentProps"]["vmax"], 0.7)
        self.assertEqual(hm["currentProps"]["alpha"], 0.5)

    def test_colorbar_patch_application(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
data = np.random.rand(8, 12)
im = ax.imshow(data, cmap="inferno")
fig.colorbar(im, ax=ax, orientation="vertical", label="Intensity")
"""
        edit_log = [
            {"gid": "colorbar.1", "prop": "label", "value": "Updated Label", "mode": "backend_patch"},
            {"gid": "colorbar.1", "prop": "tick_fontsize", "value": 16.0, "mode": "backend_patch"},
            {"gid": "colorbar.1", "prop": "visible", "value": False, "mode": "backend_patch"},
            {"gid": "colorbar.1", "prop": "width", "value": 0.05, "mode": "backend_patch"},
            {"gid": "colorbar.1", "prop": "height", "value": 0.5, "mode": "backend_patch"}
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        figures = res.get("figures", [])
        manifest = figures[0].get("manifest", {})
        objects = manifest.get("objects", [])
        
        cb = next(o for o in objects if o["id"] == "colorbar.1")
        self.assertEqual(cb["currentProps"]["label"], "Updated Label")
        self.assertEqual(cb["currentProps"]["tick_fontsize"], 16.0)
        self.assertEqual(cb["currentProps"]["visible"], False)
        self.assertAlmostEqual(cb["currentProps"]["width"], 0.05)
        self.assertAlmostEqual(cb["currentProps"]["height"], 0.5)

    def test_axis_label_color_does_not_change_tick_label_color(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_ylabel("Response")
"""
        edit_log = [
            {"gid": "axis.y.0", "prop": "label_color", "value": "#ff0000", "mode": "backend_patch"}
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]

        axis_y = next(o for o in objects if o["id"] == "axis.y.0")
        ytick = next(o for o in objects if o["id"].startswith("ytick.0."))

        self.assertEqual(axis_y["currentProps"]["label_color"].lower(), "#ff0000")
        self.assertNotEqual(ytick["currentProps"]["color"].lower(), "#ff0000")

    def test_single_tick_text_color_patch_only_changes_target_tick(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_yticks([1, 2, 3])
ax.set_yticklabels(["low", "mid", "high"])
"""
        edit_log = [
            {"gid": "ytick.0.0", "prop": "color", "value": "#00aa00", "mode": "backend_patch"}
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]

        target = next(o for o in objects if o["id"] == "ytick.0.0")
        sibling = next(o for o in objects if o["id"] == "ytick.0.1")

        self.assertEqual(target["currentProps"]["color"].lower(), "#00aa00")
        self.assertNotEqual(sibling["currentProps"]["color"].lower(), "#00aa00")

    def test_single_tick_text_patch_only_changes_target_tick_text(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3])
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
ax.set_yticks([1, 2, 3])
ax.set_yticklabels(["low", "mid", "high"])
"""
        edit_log = [
            {"gid": "ytick.0.1", "prop": "text", "value": "middle", "mode": "backend_patch"},
            {"gid": "xtick.0.2", "prop": "text", "value": "C$^{2}$", "mode": "backend_patch"},
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]

        y_target = next(o for o in objects if o["id"] == "ytick.0.1")
        y_sibling = next(o for o in objects if o["id"] == "ytick.0.0")
        x_target = next(o for o in objects if o["id"] == "xtick.0.2")
        x_sibling = next(o for o in objects if o["id"] == "xtick.0.1")

        self.assertIn("text", y_target["editable"])
        self.assertEqual(y_target["currentProps"]["text"], "middle")
        self.assertEqual(y_sibling["currentProps"]["text"], "low")
        self.assertEqual(x_target["currentProps"]["text"], "C$^{2}$")
        self.assertEqual(x_sibling["currentProps"]["text"], "B")

    def test_tick_labels_do_not_expose_unstable_position_dragging(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]

        xtick = next(o for o in objects if o["id"] == "xtick.0.0")

        self.assertNotIn("position", xtick["editable"])
        self.assertIn("fontsize", xtick["editable"])
        self.assertIn("color", xtick["editable"])
        self.assertFalse(xtick["currentProps"]["positionEditable"])
        self.assertIn("axis layout engine", xtick["currentProps"]["positionUnsupportedReason"])

    def test_axis_tick_label_offset_moves_text_without_changing_axis_limits(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
ax.set_xlim(0, 2)
"""
        edit_log = [
            {"gid": "axis.x.0", "prop": "tick_label_dx", "value": 8.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_label_dy", "value": -2.0, "mode": "backend_patch"},
        ]
        res = replay_render(script, edit_log=edit_log)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]

        axis_x = next(o for o in objects if o["id"] == "axis.x.0")

        self.assertIn("tick_label_dx", axis_x["editable"])
        self.assertIn("tick_label_dy", axis_x["editable"])
        self.assertAlmostEqual(axis_x["currentProps"]["tick_label_dx"], 8.0)
        self.assertAlmostEqual(axis_x["currentProps"]["tick_label_dy"], -2.0)
        self.assertEqual(axis_x["currentProps"]["limits"], [0.0, 2.0])

    def test_legend_position_patch_application(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2], label="A")
ax.plot([0, 1, 2], [2, 1, 3], label="B")
ax.legend(loc="upper left", title="Group")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        initial_objects = initial["figures"][0]["manifest"]["objects"]
        initial_legend = next(o for o in initial_objects if o["id"] == "legend.0")

        self.assertIn("position", initial_legend["editable"])
        self.assertEqual(initial_legend["currentProps"]["coord_system"], "figure")
        self.assertIsInstance(initial_legend["currentProps"]["x"], float)
        self.assertIsInstance(initial_legend["currentProps"]["y"], float)

        edit_log = [
            {
                "gid": "legend.0",
                "prop": "position",
                "value": {"x": 0.72, "y": 0.36, "coord_system": "figure"},
                "mode": "backend_patch",
            }
        ]
        patched = replay_render(script, edit_log=edit_log)
        self.assertEqual(patched.get("status"), "success")
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_legend = next(o for o in patched_objects if o["id"] == "legend.0")

        self.assertAlmostEqual(patched_legend["currentProps"]["x"], 0.72, places=2)
        self.assertAlmostEqual(patched_legend["currentProps"]["y"], 0.36, places=2)
        self.assertEqual(patched_legend["currentProps"]["coord_system"], "figure")

    def test_legend_child_text_does_not_expose_unstable_position_dragging(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2], label="A")
ax.plot([0, 1, 2], [2, 1, 3], label="B")
ax.legend(loc="upper left", title="Group")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        initial_objects = initial["figures"][0]["manifest"]["objects"]

        legend = next(o for o in initial_objects if o["id"] == "legend.0")
        legend_text = next(o for o in initial_objects if o["id"] == "legend_text.0.0")

        self.assertIn("position", legend["editable"])
        self.assertNotIn("position", legend_text["editable"])
        self.assertFalse(legend_text["currentProps"]["positionEditable"])
        self.assertIn("legend container", legend_text["currentProps"]["positionUnsupportedReason"])

        patched = replay_render(script, edit_log=[
            {
                "gid": "legend_text.0.0",
                "prop": "position",
                "value": {"x": 0.1, "y": 0.1, "coord_system": "figure"},
                "mode": "backend_patch",
            }
        ])
        self.assertEqual(patched.get("status"), "success")
        warning_types = [w.get("type") for w in patched.get("warnings", [])]
        self.assertIn("unsupported_legend_child_position", warning_types)

    def test_all_fixtures_pipeline(self):
        fixtures_dir = os.path.join(project_root, "tests", "fixtures", "artist_introspection")
        for filename in os.listdir(fixtures_dir):
            if not filename.endswith(".py"):
                continue
                
            filepath = os.path.join(fixtures_dir, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                script = f.read()
                
            # 1. Render & Introspect
            res = replay_render(script)
            self.assertEqual(res.get("status"), "success", f"Fixture {filename} failed to render: {res.get('message')}")
            
            figures = res.get("figures", [])
            self.assertTrue(len(figures) >= 1)
            manifest = figures[0].get("manifest", {})
            objects = manifest.get("objects", [])
            self.assertTrue(len(objects) > 0)
            
            # Find the first object with editable properties
            editable_obj = next((o for o in objects if o.get("editable")), None)
            if not editable_obj:
                continue
                
            prop = editable_obj["editable"][0]
            val = editable_obj["currentProps"].get(prop)
            
            # Generate a mock modified value
            mock_val = val
            if isinstance(val, bool):
                mock_val = not val
            elif isinstance(val, (int, float)):
                mock_val = val + 1.0
            elif isinstance(val, str):
                if prop.endswith("color") or prop == "cmap":
                    mock_val = "red" if prop != "cmap" else "inferno"
                else:
                    mock_val = val + "_mod"
                    
            # 2. Patch & Replay & Export
            edit_log = [{
                "gid": editable_obj["id"],
                "prop": prop,
                "value": mock_val,
                "mode": "backend_patch"
            }]
            
            res_patched = replay_render(script, edit_log=edit_log)
            self.assertEqual(res_patched.get("status"), "success", f"Fixture {filename} failed to replay patch: {res_patched.get('message')}")
            self.assertTrue(len(res_patched.get("figures", [])) >= 1)
            
            patched_svg = res_patched["figures"][0].get("svg", "")
            self.assertTrue(len(patched_svg) > 0, f"Patched SVG for {filename} is empty")

if __name__ == "__main__":
    unittest.main()

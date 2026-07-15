import os
import sys
import json
import unittest

# Ensure the renderer directory is in the Python search path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render
from semantic_scanner import scan_source
from binding_engine import build_bindings

class TestArtistIntrospection(unittest.TestCase):

    @staticmethod
    def _binding_artist(gid, kind, label, props, series_key):
        return {
            "id": gid,
            "kind": kind,
            "label": label,
            "currentProps": props,
            "identity": {
                "instanceKey": f"subplot:{gid}",
                "seriesKey": series_key,
            },
        }

    def test_palette_binding_separates_same_color_semantic_groups(self):
        semantic = {
            "palettes": [
                {"id": "dict_COLORS__Weak", "color": "#225588"},
                {"id": "dict_COLORS__Mixed", "color": "#225588"},
            ],
            "groups": [
                {"groupId": "group_Weak", "label": "Weak", "paletteId": "dict_COLORS__Weak"},
                {"groupId": "group_Mixed", "label": "Mixed", "paletteId": "dict_COLORS__Mixed"},
            ],
        }
        artists = [
            self._binding_artist("line.0.0", "line", "Weak", {"color": "#225588"}, "weak-series"),
            self._binding_artist("legend_line.0.0", "line", "Weak", {"color": "#225588"}, "weak-legend"),
            self._binding_artist("line.0.1", "line", "Mixed", {"color": "#225588"}, "mixed-series"),
            self._binding_artist("legend_line.0.1", "line", "Mixed", {"color": "#225588"}, "mixed-legend"),
        ]

        bindings = build_bindings(semantic, artists)
        weak = next(binding for binding in bindings if binding["paletteId"] == "dict_COLORS__Weak")
        mixed = next(binding for binding in bindings if binding["paletteId"] == "dict_COLORS__Mixed")

        self.assertEqual(weak["targetMode"], "exact")
        self.assertEqual(weak["gids"], ["line.0.0", "legend_line.0.0"])
        self.assertEqual(mixed["gids"], ["line.0.1", "legend_line.0.1"])
        self.assertTrue(all(target["match"] == "label_and_color" for target in weak["targets"]))
        self.assertEqual({target["seriesKey"] for target in weak["targets"]}, {"weak-series", "weak-legend"})

    def test_palette_binding_rejects_duplicate_color_without_semantics(self):
        semantic = {
            "palettes": [
                {"id": "COLOR_A", "color": "#335577"},
                {"id": "COLOR_B", "color": "#335577"},
            ],
            "groups": [],
        }
        artists = [
            self._binding_artist("line.0.0", "line", "series", {"color": "#335577"}, "series-0"),
        ]

        bindings = build_bindings(semantic, artists)

        self.assertEqual(len(bindings), 2)
        self.assertTrue(all(binding["targetMode"] == "ambiguous" for binding in bindings))
        self.assertTrue(all(binding["gids"] == [] and binding["targets"] == [] for binding in bindings))

    def test_unused_duplicate_constants_do_not_block_vector_color_code_replay(self):
        script = '''
PRIMARY_COLOR = "#1F78B4"
SECONDARY_COLOR = "#D62728"
PROMOTION = "#1F78B4"
INHIBITION = "#D62728"
colors = [PROMOTION, INHIBITION, PROMOTION]
'''
        semantic = scan_source(script)
        palettes = {palette["id"]: palette for palette in semantic["palettes"]}
        self.assertEqual(palettes["PRIMARY_COLOR"]["usageCount"], 0)
        self.assertEqual(palettes["SECONDARY_COLOR"]["usageCount"], 0)
        self.assertEqual(palettes["PROMOTION"]["usageCount"], 2)
        self.assertEqual(palettes["INHIBITION"]["usageCount"], 1)

        artists = [self._binding_artist(
            "collection.0.0",
            "collection",
            "_nolegend_",
            {"facecolor": [[0.1215686, 0.4705882, 0.7058823, 1], [0.8392157, 0.1529412, 0.1568627, 1]]},
            "scatter-series",
        )]
        bindings = build_bindings(semantic, artists)
        by_palette = {binding["paletteId"]: binding for binding in bindings}

        self.assertNotIn("PRIMARY_COLOR", by_palette)
        self.assertNotIn("SECONDARY_COLOR", by_palette)
        self.assertEqual(by_palette["PROMOTION"]["targets"][0]["replayMode"], "code_only")
        self.assertEqual(by_palette["INHIBITION"]["targets"][0]["replayMode"], "code_only")

    def test_unique_unused_constant_keeps_dynamic_artist_fallback(self):
        semantic = scan_source('DYNAMIC_COLOR = "#123456"\ndynamic_color = "#" + "123456"')
        artists = [self._binding_artist(
            "line.0.0", "line", "dynamic", {"color": "#123456"}, "dynamic-series"
        )]

        binding = build_bindings(semantic, artists)[0]

        self.assertEqual(binding["paletteId"], "DYNAMIC_COLOR")
        self.assertEqual(binding["gids"], ["line.0.0"])
        self.assertEqual(binding["targets"][0].get("replayMode"), None)

    def test_palette_binding_keeps_per_target_color_property(self):
        semantic = {
            "palettes": [{"id": "SERIES_COLOR", "color": "#116633"}],
            "groups": [{"groupId": "group_series", "label": "Series", "paletteId": "SERIES_COLOR"}],
        }
        artists = [
            self._binding_artist("line.0.0", "line", "Series", {"color": "#116633"}, "line-series"),
            self._binding_artist("patch.0.0", "patch", "Series", {"facecolor": "#116633", "edgecolor": "#000000"}, "patch-series"),
        ]

        binding = build_bindings(semantic, artists)[0]
        target_props = {target["gid"]: target["prop"] for target in binding["targets"]}

        self.assertEqual(target_props, {"line.0.0": "color", "patch.0.0": "facecolor"})
        self.assertEqual(binding["props"], ["facecolor", "color"])

    def test_palette_binding_rejects_duplicate_exact_label_and_color_signature(self):
        semantic = {
            "palettes": [
                {"id": "DICT_A__Weak", "color": "#778899"},
                {"id": "DICT_B__Weak", "color": "#778899"},
            ],
            "groups": [
                {"groupId": "group_a", "label": "Weak", "paletteId": "DICT_A__Weak"},
                {"groupId": "group_b", "label": "Weak", "paletteId": "DICT_B__Weak"},
            ],
        }
        artists = [
            self._binding_artist("line.0.0", "line", "Weak", {"color": "#778899"}, "weak-series"),
        ]

        bindings = build_bindings(semantic, artists)

        self.assertEqual(len(bindings), 2)
        self.assertTrue(all(binding["targetMode"] == "ambiguous" for binding in bindings))

    def test_shadow_identity_is_stable_across_style_edits(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2], label="response")
"""
        baseline = replay_render(script)
        patched = replay_render(script, edit_log=[
            {"gid": "line.0.0", "prop": "color", "value": "#cc0000", "mode": "local_patch"}
        ])

        baseline_line = next(
            obj for obj in baseline["figures"][0]["manifest"]["objects"]
            if obj["id"] == "line.0.0"
        )
        baseline_objects = baseline["figures"][0]["manifest"]["objects"]
        instance_keys = [obj["identity"]["instanceKey"] for obj in baseline_objects]
        self.assertEqual(len(instance_keys), len(set(instance_keys)))
        for obj in baseline_objects:
            capability_props = [item["prop"] for item in obj["propertyCapabilities"]]
            self.assertEqual(sorted(obj["editable"]), sorted(capability_props))
        patched_line = next(
            obj for obj in patched["figures"][0]["manifest"]["objects"]
            if obj["id"] == "line.0.0"
        )

        self.assertEqual(
            baseline_line["identity"]["instanceKey"],
            patched_line["identity"]["instanceKey"]
        )
        self.assertEqual(
            baseline_line["identity"]["semanticKey"],
            patched_line["identity"]["semanticKey"]
        )
        self.assertEqual(
            baseline_line["identity"]["seriesKey"],
            patched_line["identity"]["seriesKey"]
        )
        color_capability = next(
            capability for capability in patched_line["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertEqual(color_capability["patchMode"], "local_patch")
        self.assertEqual(color_capability["replay"], "stable")
        self.assertIn("object", color_capability["scopes"])
        self.assertIn("cross_figure", color_capability["scopes"])

    def test_spine_group_declares_axis_frame_group_capability(self):
        rendered = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1], [0, 1])
""")

        spine_group = next(
            obj for obj in rendered["figures"][0]["manifest"]["objects"]
            if obj["id"] == "spine_group.0"
        )
        linewidth = next(
            capability for capability in spine_group["propertyCapabilities"]
            if capability["prop"] == "linewidth"
        )

        self.assertEqual(spine_group["role"], "axis_frame")
        self.assertIn("group", linewidth["scopes"])
    
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
ax.errorbar(x, y, yerr=yerr, fmt='o-', capsize=4, label="growth")
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
        self.assertAlmostEqual(container["currentProps"]["capsize"], 4.0)
        self.assertEqual(container["identity"]["seriesKey"], container["stableKey"])
        capsize_capability = next(
            item for item in container["propertyCapabilities"]
            if item["prop"] == "capsize"
        )
        self.assertEqual(capsize_capability["patchMode"], "backend_patch")
        
        # Verify children parentId link
        child_id = container["children"][0]
        child_obj = next(o for o in objects if o["id"] == child_id)
        self.assertEqual(child_obj["parentId"], container["id"])
        self.assertEqual(child_obj["role"], "errorbar_series")

        patched = replay_render(script, edit_log=[{
            "gid": container["id"],
            "prop": "capsize",
            "value": 7,
            "mode": "backend_patch",
        }])
        patched_container = next(
            obj for obj in patched["figures"][0]["manifest"]["objects"]
            if obj["id"] == container["id"]
        )
        self.assertAlmostEqual(patched_container["currentProps"]["capsize"], 7.0)

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
        colorbar_capabilities = {
            capability["prop"]: capability
            for capability in cb["propertyCapabilities"]
        }
        for prop in ("left", "bottom", "width", "height"):
            self.assertEqual(colorbar_capabilities[prop]["coordinateSpace"], "figure")
        subplot = next(obj for obj in objects if obj["id"] == "subplot.0")
        subplot_capabilities = {
            capability["prop"]: capability
            for capability in subplot["propertyCapabilities"]
        }
        for prop in ("left", "bottom", "width", "height"):
            self.assertEqual(subplot_capabilities[prop]["coordinateSpace"], "figure")
        self.assertEqual(subplot_capabilities["aspect"]["coordinateSpace"], "container")
        colorbar_children = [
            obj for obj in objects
            if obj.get("identity", {}).get("relation", {}).get("colorbarId") == cb["id"]
            and obj.get("source", {}).get("axesIndex") == cb["source"]["axesIndex"]
        ]
        self.assertTrue(colorbar_children)
        for child in colorbar_children:
            relation = child["identity"]["relation"]
            self.assertEqual(relation.get("subplotId"), "subplot.0")
            self.assertNotEqual(relation.get("subplotId"), f"subplot.{cb['source']['axesIndex']}")
            self.assertEqual(child["identity"]["scope"], "container")

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

    def test_dual_heatmaps_have_explicit_colorbar_mappable_and_owner_relationships(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, axes = plt.subplots(1, 2)
left = axes[0].imshow(np.arange(16).reshape(4, 4), cmap="viridis")
right = axes[1].imshow(np.arange(16, 32).reshape(4, 4), cmap="magma")
fig.colorbar(left, ax=axes[0], label="Left scale")
fig.colorbar(right, ax=axes[1], label="Right scale")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]
        by_id = {obj["id"]: obj for obj in objects}

        left_heatmap = by_id["heatmap.image.0.0"]
        right_heatmap = by_id["heatmap.image.1.0"]
        left_colorbar = by_id[left_heatmap["identity"]["relation"]["colorbarId"]]
        right_colorbar = by_id[right_heatmap["identity"]["relation"]["colorbarId"]]

        self.assertNotEqual(left_colorbar["id"], right_colorbar["id"])
        self.assertEqual(left_colorbar["identity"]["relation"]["mappableId"], left_heatmap["id"])
        self.assertEqual(right_colorbar["identity"]["relation"]["mappableId"], right_heatmap["id"])
        self.assertEqual(left_colorbar["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertEqual(right_colorbar["identity"]["relation"]["subplotId"], "subplot.1")
        self.assertEqual(left_colorbar["subplotId"], "subplot.0")
        self.assertEqual(right_colorbar["subplotId"], "subplot.1")
        self.assertEqual(left_colorbar["source"]["ownerAxesIndex"], 0)
        self.assertEqual(right_colorbar["source"]["ownerAxesIndex"], 1)
        self.assertNotEqual(left_colorbar["source"]["axesIndex"], left_colorbar["source"]["ownerAxesIndex"])
        self.assertNotEqual(right_colorbar["source"]["axesIndex"], right_colorbar["source"]["ownerAxesIndex"])

        patched = replay_render(script, edit_log=[
            {"gid": left_colorbar["id"], "prop": "label", "value": "Left updated", "mode": "backend_patch"},
            {"gid": left_colorbar["id"], "prop": "width", "value": 0.04, "mode": "backend_patch"},
        ])
        self.assertEqual(patched.get("status"), "success")
        patched_by_id = {obj["id"]: obj for obj in patched["figures"][0]["manifest"]["objects"]}
        self.assertEqual(patched_by_id[left_colorbar["id"]]["currentProps"]["label"], "Left updated")
        self.assertEqual(patched_by_id[right_colorbar["id"]]["currentProps"]["label"], "Right scale")
        self.assertEqual(
            patched_by_id[left_colorbar["id"]]["identity"]["relation"]["mappableId"],
            left_heatmap["id"],
        )
        self.assertEqual(
            patched_by_id[right_colorbar["id"]]["identity"]["relation"]["mappableId"],
            right_heatmap["id"],
        )

    def test_shared_colorbar_preserves_all_owner_subplots(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, axes = plt.subplots(1, 2)
norm = plt.Normalize(0, 15)
left = axes[0].imshow(np.arange(16).reshape(4, 4), cmap="viridis", norm=norm)
axes[1].imshow(np.arange(16).reshape(4, 4), cmap="viridis", norm=norm)
fig.colorbar(left, ax=list(axes), label="Shared scale")
"""
        res = replay_render(script)
        self.assertEqual(res.get("status"), "success")
        objects = res["figures"][0]["manifest"]["objects"]
        colorbar = next(obj for obj in objects if obj["kind"] == "colorbar")
        relation = colorbar["identity"]["relation"]
        right_heatmap = next(obj for obj in objects if obj["id"] == "heatmap.image.1.0")

        self.assertEqual(colorbar["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertNotIn("subplotId", colorbar)
        self.assertEqual(relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertNotIn("subplotId", relation)
        self.assertEqual(relation["mappableId"], "heatmap.image.0.0")
        self.assertEqual(relation["mappableIds"], ["heatmap.image.0.0", "heatmap.image.1.0"])
        self.assertEqual(colorbar["source"]["ownerAxesIndices"], [0, 1])
        self.assertEqual(colorbar["identity"]["scope"], "container")
        left_heatmap = next(obj for obj in objects if obj["id"] == "heatmap.image.0.0")
        self.assertEqual(left_heatmap["identity"]["relation"]["colorbarId"], colorbar["id"])
        self.assertEqual(right_heatmap["identity"]["relation"]["colorbarId"], colorbar["id"])
        shared_colorbar_children = [
            obj for obj in objects
            if obj.get("identity", {}).get("relation", {}).get("colorbarId") == colorbar["id"]
            and obj.get("source", {}).get("axesIndex") == colorbar["source"]["axesIndex"]
        ]
        self.assertTrue(shared_colorbar_children)
        self.assertTrue(all(
            child["identity"]["relation"].get("subplotIds") == ["subplot.0", "subplot.1"]
            and "subplotId" not in child["identity"]["relation"]
            for child in shared_colorbar_children
        ))
        left_capability = next(
            capability for capability in colorbar["propertyCapabilities"]
            if capability["prop"] == "left"
        )
        self.assertNotIn("subplot", left_capability["scopes"])

    def test_stem_container_relationships_and_patch_replay(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.stem([0, 1, 2], [1, 2, 1], label="Signal")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        initial_objects = initial["figures"][0]["manifest"]["objects"]
        stem = next(obj for obj in initial_objects if obj["kind"] == "stem_container")

        self.assertEqual(stem["role"], "stem_series")
        self.assertEqual(stem["identity"]["seriesKey"], stem["stableKey"])
        self.assertEqual(len(stem["children"]), 3)
        for child_id in stem["children"]:
            child = next(obj for obj in initial_objects if obj["id"] == child_id)
            self.assertEqual(child["parentId"], stem["id"])
            self.assertEqual(child["role"], "stem_series")
        color_capability = next(
            capability for capability in stem["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertEqual(color_capability["patchMode"], "backend_patch")

        patched = replay_render(script, edit_log=[
            {"gid": stem["id"], "prop": "stem_color", "value": "#cc2255", "mode": "backend_patch"},
            {"gid": stem["id"], "prop": "stem_linewidth", "value": 2.8, "mode": "backend_patch"},
            {"gid": stem["id"], "prop": "marker_color", "value": "#2255cc", "mode": "backend_patch"},
            {"gid": stem["id"], "prop": "markersize", "value": 9.0, "mode": "backend_patch"},
            {"gid": stem["id"], "prop": "baseline_visible", "value": False, "mode": "backend_patch"},
        ])
        self.assertEqual(patched.get("status"), "success")
        patched_stem = next(
            obj for obj in patched["figures"][0]["manifest"]["objects"]
            if obj["id"] == stem["id"]
        )
        self.assertEqual(patched_stem["currentProps"]["stem_color"], "#cc2255")
        self.assertAlmostEqual(patched_stem["currentProps"]["stem_linewidth"], 2.8)
        self.assertEqual(patched_stem["currentProps"]["marker_color"], "#2255cc")
        self.assertAlmostEqual(patched_stem["currentProps"]["markersize"], 9.0)
        self.assertFalse(patched_stem["currentProps"]["baseline_visible"])

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

    def test_axis_tick_line_and_tick_label_colors_are_independent(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
"""
        result = replay_render(script, edit_log=[
            {"gid": "axis.x.0", "prop": "tick_color", "value": "#ff0000", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_width", "value": 2.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_labelcolor", "value": "#00aa00", "mode": "backend_patch"},
        ])
        self.assertEqual(result.get("status"), "success")
        objects = result["figures"][0]["manifest"]["objects"]
        axis_x = next(obj for obj in objects if obj["id"] == "axis.x.0")
        tick_labels = [obj for obj in objects if obj["id"].startswith("xtick.0.")]
        self.assertEqual(axis_x["currentProps"]["tick_color"].lower(), "#ff0000")
        self.assertAlmostEqual(axis_x["currentProps"]["tick_width"], 2.0)
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"].lower(), "#00aa00")
        self.assertTrue(tick_labels)
        self.assertTrue(all(label["currentProps"]["color"].lower() == "#00aa00" for label in tick_labels))
        self.assertTrue(all(label["currentProps"]["color"].lower() != "#ff0000" for label in tick_labels))

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

    def test_times_new_roman_request_is_preserved_separately_from_resolved_font(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3], label="Series")
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
ax.set_title("Title")
ax.text(0.5, 0.5, "Body", transform=ax.transAxes)
ax.legend(title="Legend")
"""
        result = replay_render(script, edit_log=[
            {"gid": "text.0.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_labelfamily", "value": "Times New Roman", "mode": "backend_patch"},
        ])
        self.assertEqual(result.get("status"), "success")
        objects = {obj["id"]: obj for obj in result["figures"][0]["manifest"]["objects"]}

        text_obj = objects["text.0.0"]
        legend_text = objects["legend_text.0.0"]
        legend_title = objects["legend_title.0"]
        xtick = objects["xtick.0.0"]
        axis_x = objects["axis.x.0"]

        for obj in (text_obj, legend_text, legend_title, xtick):
            self.assertEqual(obj["currentProps"]["fontfamily"], "Times New Roman")
            self.assertTrue(obj["currentProps"]["resolvedFontfamily"])
            self.assertNotEqual(obj["currentProps"]["resolvedFontfamily"], "DejaVu Sans")

        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "Times New Roman")
        self.assertTrue(axis_x["currentProps"]["resolvedTickLabelfamily"])
        self.assertEqual(axis_x["currentProps"]["resolvedFontfamily"], axis_x["currentProps"]["resolvedTickLabelfamily"])
        self.assertNotEqual(axis_x["currentProps"]["resolvedTickLabelfamily"], "DejaVu Sans")

    def test_text_content_requires_backend_patch_capability(self):
        result = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.text(0.5, 0.5, "A\\n$B^2$", transform=ax.transAxes)
""")
        self.assertEqual(result.get("status"), "success")
        text_obj = next(
            obj for obj in result["figures"][0]["manifest"]["objects"]
            if obj["id"] == "text.0.0"
        )
        text_capability = next(
            capability for capability in text_obj["propertyCapabilities"]
            if capability["prop"] == "text"
        )
        self.assertEqual(text_capability["patchMode"], "backend_patch")
        self.assertEqual(text_capability["preview"], "none")

    def test_axis_tick_typography_has_narrow_group_scope(self):
        result = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3])
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["A", "B", "C"])
""")
        self.assertEqual(result.get("status"), "success")
        axis_x = next(
            obj for obj in result["figures"][0]["manifest"]["objects"]
            if obj["id"] == "axis.x.0"
        )
        scopes_by_prop = {
            capability["prop"]: capability["scopes"]
            for capability in axis_x["propertyCapabilities"]
        }

        for prop in {
            "tick_labelsize",
            "tick_labelcolor",
            "tick_labelfamily",
            "tick_fontweight",
            "tick_fontstyle",
            "tick_rotation",
        }:
            self.assertIn("group", scopes_by_prop[prop])

        for prop in {"limits", "label", "label_color", "tick_length", "tick_width"}:
            self.assertNotIn("group", scopes_by_prop[prop])

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

    def test_axis_label_drag_replays_effective_axes_position(self):
        script = '''
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(5, 3.5))
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_xlabel("X Axis")
ax.set_ylabel("Y Axis")
fig.tight_layout()
'''
        baseline = replay_render(script)
        baseline_objects = baseline["figures"][0]["manifest"]["objects"]
        xlabel = next(obj for obj in baseline_objects if obj["id"] == "xlabel.0")
        ylabel = next(obj for obj in baseline_objects if obj["id"] == "ylabel.0")

        self.assertIn("position", xlabel["editable"])
        self.assertIn("position", ylabel["editable"])
        self.assertEqual(xlabel["currentProps"]["coord_system"], "axes")
        self.assertEqual(ylabel["currentProps"]["coord_system"], "axes")
        self.assertAlmostEqual(xlabel["currentProps"]["x"], 0.5, places=3)
        self.assertLess(xlabel["currentProps"]["y"], 0)
        self.assertLess(ylabel["currentProps"]["x"], 0)
        self.assertAlmostEqual(ylabel["currentProps"]["y"], 0.5, places=3)

        xlabel_target = {
            "x": xlabel["currentProps"]["x"] + 0.16,
            "y": xlabel["currentProps"]["y"] - 0.12,
            "coord_system": "axes",
        }
        ylabel_target = {
            "x": ylabel["currentProps"]["x"] - 0.14,
            "y": ylabel["currentProps"]["y"] + 0.18,
            "coord_system": "axes",
        }
        patched = replay_render(script, edit_log=[
            {"gid": "xlabel.0", "prop": "position", "value": xlabel_target, "mode": "backend_patch"},
            {"gid": "ylabel.0", "prop": "position", "value": ylabel_target, "mode": "backend_patch"},
        ])
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_xlabel = next(obj for obj in patched_objects if obj["id"] == "xlabel.0")
        patched_ylabel = next(obj for obj in patched_objects if obj["id"] == "ylabel.0")

        for prop in ("x", "y"):
            self.assertAlmostEqual(patched_xlabel["currentProps"][prop], xlabel_target[prop], places=4)
            self.assertAlmostEqual(patched_ylabel["currentProps"][prop], ylabel_target[prop], places=4)
        self.assertEqual(patched_xlabel["currentProps"]["coord_system"], "axes")
        self.assertEqual(patched_ylabel["currentProps"]["coord_system"], "axes")

        legacy = replay_render(script, edit_log=[
            {
                "gid": "xlabel.0",
                "prop": "position",
                "value": {"x": 0.5, "y": 23.5, "coord_system": "axes"},
                "mode": "backend_patch",
            },
        ])
        legacy_xlabel = next(
            obj for obj in legacy["figures"][0]["manifest"]["objects"]
            if obj["id"] == "xlabel.0"
        )
        self.assertLess(legacy_xlabel["currentProps"]["y"], 0)
        self.assertIn(
            "unsupported_legacy_axis_label_position",
            [warning.get("type") for warning in legacy.get("warnings", [])],
        )

    def test_axes_titles_drag_replays_without_auto_position_reset(self):
        script = '''
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(5, 3.5))
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_title("Center title")
ax.set_title("Left title", loc="left")
ax.set_title("Right title", loc="right")
fig.tight_layout()
'''
        baseline = replay_render(script)
        baseline_objects = baseline["figures"][0]["manifest"]["objects"]
        title_ids = ["title.0", "title.left.0", "title.right.0"]
        titles = {obj["id"]: obj for obj in baseline_objects if obj["id"] in title_ids}
        self.assertEqual(set(titles), set(title_ids))

        x_offsets = {"title.0": 0.12, "title.left.0": 0.06, "title.right.0": -0.08}
        targets = {
            gid: {
                "x": title["currentProps"]["x"] + x_offsets[gid],
                "y": title["currentProps"]["y"] + 0.18,
                "coord_system": "axes",
            }
            for gid, title in titles.items()
        }
        patched = replay_render(script, edit_log=[
            {"gid": gid, "prop": "position", "value": target, "mode": "backend_patch"}
            for gid, target in targets.items()
        ])
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_titles = {obj["id"]: obj for obj in patched_objects if obj["id"] in title_ids}

        for gid, target in targets.items():
            self.assertAlmostEqual(patched_titles[gid]["currentProps"]["x"], target["x"], places=4)
            self.assertAlmostEqual(patched_titles[gid]["currentProps"]["y"], target["y"], places=4)
            self.assertEqual(patched_titles[gid]["currentProps"]["coord_system"], "axes")

    def test_raster_export_dpi_controls_pixels_and_tiff_metadata(self):
        import base64
        import io
        from PIL import Image

        script = '''
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_title("DPI export")
'''
        png_150 = replay_render(script, dpi=150, export_format="png")
        png_300 = replay_render(script, dpi=300, export_format="png")
        image_150 = Image.open(io.BytesIO(base64.b64decode(png_150["figures"][0]["binary_b64"])))
        image_300 = Image.open(io.BytesIO(base64.b64decode(png_300["figures"][0]["binary_b64"])))
        self.assertAlmostEqual(image_300.width / image_150.width, 2.0, delta=0.02)
        self.assertAlmostEqual(image_300.height / image_150.height, 2.0, delta=0.02)
        self.assertAlmostEqual(float(image_150.info["dpi"][0]), 150, delta=1)
        self.assertAlmostEqual(float(image_300.info["dpi"][0]), 300, delta=1)

        tiff_600 = replay_render(script, dpi=600, export_format="tiff")
        tiff_image = Image.open(io.BytesIO(base64.b64decode(tiff_600["figures"][0]["binary_b64"])))
        tiff_dpi = tiff_image.info.get("dpi")
        self.assertIsNotNone(tiff_dpi)
        self.assertAlmostEqual(float(tiff_dpi[0]), 600, delta=1)
        self.assertAlmostEqual(float(tiff_dpi[1]), 600, delta=1)

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

    def test_data_coordinate_text_and_annotation_position_patch(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.set_xlim(-2, 2)
ax.set_ylim(-2, 2)
ax.arrow(0, 0, 1, 0.6, length_includes_head=True)
ax.text(1.1, 0.7, "PCoA_TEXT", fontsize=10)
ax.annotate("PCoA_ANN", xy=(0, 0), xytext=(-1.1, 0.8), arrowprops=dict(arrowstyle="->"))
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        initial_objects = initial["figures"][0]["manifest"]["objects"]
        text_obj = next(o for o in initial_objects if o["currentProps"].get("text") == "PCoA_TEXT")
        ann_obj = next(o for o in initial_objects if o["currentProps"].get("text") == "PCoA_ANN")
        arrow_obj = next(o for o in initial_objects if o.get("role") == "annotation_arrow")

        self.assertIn("position", text_obj["editable"])
        self.assertIn("position", ann_obj["editable"])
        self.assertIn("anchor_position", ann_obj["editable"])
        self.assertEqual(text_obj["currentProps"]["coord_system"], "data")
        self.assertEqual(ann_obj["currentProps"]["coord_system"], "data")
        self.assertEqual(ann_obj["role"], "annotation_text")
        self.assertEqual(ann_obj["identity"]["relation"]["annotationId"], ann_obj["id"])
        self.assertEqual(ann_obj["identity"]["relation"]["arrowId"], arrow_obj["id"])
        self.assertEqual(arrow_obj["identity"]["relation"]["annotationId"], ann_obj["id"])
        self.assertEqual(arrow_obj["identity"]["relation"]["textId"], ann_obj["id"])
        self.assertEqual(ann_obj["currentProps"]["anchor_position"], {
            "x": 0.0,
            "y": 0.0,
            "coord_system": "data",
        })
        self.assertFalse(any(o["id"].startswith("patch.") and o.get("role") == "annotation_arrow" for o in initial_objects))

        patched = replay_render(script, edit_log=[
            {"gid": text_obj["id"], "prop": "position", "value": {"x": 1.35, "y": 1.05, "coord_system": "data"}, "mode": "backend_patch"},
            {"gid": ann_obj["id"], "prop": "position", "value": {"x": -0.8, "y": 1.15, "coord_system": "data"}, "mode": "backend_patch"},
            {"gid": ann_obj["id"], "prop": "anchor_position", "value": {"x": 0.25, "y": 0.35, "coord_system": "data"}, "mode": "backend_patch"},
            {"gid": arrow_obj["id"], "prop": "linewidth", "value": 2.5, "mode": "backend_patch"},
        ])
        self.assertEqual(patched.get("status"), "success")
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_text = next(o for o in patched_objects if o["id"] == text_obj["id"])
        patched_ann = next(o for o in patched_objects if o["id"] == ann_obj["id"])
        patched_arrow = next(o for o in patched_objects if o["id"] == arrow_obj["id"])

        self.assertAlmostEqual(patched_text["currentProps"]["x"], 1.35)
        self.assertAlmostEqual(patched_text["currentProps"]["y"], 1.05)
        self.assertAlmostEqual(patched_ann["currentProps"]["x"], -0.8)
        self.assertAlmostEqual(patched_ann["currentProps"]["y"], 1.15)
        self.assertEqual(patched_ann["currentProps"]["coord_system"], "data")
        self.assertEqual(patched_ann["currentProps"]["anchor_position"], {
            "x": 0.25,
            "y": 0.35,
            "coord_system": "data",
        })
        self.assertAlmostEqual(patched_arrow["currentProps"]["linewidth"], 2.5)
        self.assertEqual(patched_ann["identity"]["instanceKey"], ann_obj["identity"]["instanceKey"])
        self.assertEqual(patched_ann["identity"]["relation"]["arrowId"], arrow_obj["id"])

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

    def test_legend_markerscale_updates_visible_handles(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 1], marker="o", markersize=5, label="Line")
ax.scatter([0, 1, 2], [2, 1, 3], s=20, label="Scatter")
ax.legend()
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        initial_objects = initial["figures"][0]["manifest"]["objects"]
        initial_legend = next(o for o in initial_objects if o["id"] == "legend.0")
        initial_line = next(o for o in initial_objects if o["id"] == "legend_line.0.0")
        initial_collection = next(o for o in initial_objects if o["id"].startswith("legend_collection.0."))
        initial_texts = [o for o in initial_objects if o["id"].startswith("legend_text.0.")]

        legend_relation = initial_legend["identity"]["relation"]
        self.assertEqual(legend_relation["legendTextIds"], ["legend_text.0.0", "legend_text.0.1"])
        self.assertEqual(legend_relation["legendMarkerIds"], [initial_line["id"], initial_collection["id"]])
        self.assertEqual(initial_line["identity"]["relation"]["legendTextId"], "legend_text.0.0")
        self.assertEqual(initial_collection["identity"]["relation"]["legendTextId"], "legend_text.0.1")
        self.assertEqual(initial_texts[0]["identity"]["relation"]["legendMarkerIds"], [initial_line["id"]])
        self.assertEqual(initial_texts[1]["identity"]["relation"]["legendMarkerIds"], [initial_collection["id"]])

        patched = replay_render(script, edit_log=[
            {"gid": "legend.0", "prop": "markerscale", "value": 2.0, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "marker_yoffset", "value": 3.0, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "handletextpad", "value": 0.4, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "labelspacing", "value": 0.2, "mode": "backend_patch"},
        ])
        self.assertEqual(patched.get("status"), "success")
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_legend = next(o for o in patched_objects if o["id"] == "legend.0")
        patched_line = next(o for o in patched_objects if o["id"] == "legend_line.0.0")
        patched_collection = next(o for o in patched_objects if o["id"] == initial_collection["id"])

        self.assertEqual(initial_legend["currentProps"]["markerscale"], 1.0)
        self.assertEqual(patched_legend["currentProps"]["markerscale"], 2.0)
        self.assertEqual(patched_legend["currentProps"]["marker_yoffset"], 3.0)
        self.assertEqual(patched_legend["currentProps"]["handletextpad"], 0.4)
        self.assertEqual(patched_legend["currentProps"]["labelspacing"], 0.2)
        self.assertNotEqual(initial["figures"][0]["svg"], patched["figures"][0]["svg"])
        self.assertGreater(
            patched_line["currentProps"]["markersize"],
            initial_line["currentProps"]["markersize"] * 1.9,
        )
        self.assertGreater(
            patched_collection["currentProps"]["size"],
            initial_collection["currentProps"]["size"] * 3.9,
        )
        self.assertEqual(patched_line["identity"]["relation"]["legendTextId"], "legend_text.0.0")
        self.assertEqual(patched_collection["identity"]["relation"]["legendTextId"], "legend_text.0.1")

    def test_figure_level_shared_legend_is_introspected_and_patchable(self):
        script = """
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 2)
handles = []
labels = []
for ax, offset in zip(axes, [0, 1]):
    line_a, = ax.plot([0, 1, 2], [1 + offset, 2 + offset, 3 + offset], marker="o", label="A")
    line_b, = ax.plot([0, 1, 2], [3 + offset, 2 + offset, 1 + offset], marker="s", label="B")
    if not handles:
        handles = [line_a, line_b]
        labels = ["Promoted", "Suppressed"]
fig.legend(handles, labels, loc="lower center", bbox_to_anchor=(0.5, 0.02), ncol=2, title="Shared")
fig.tight_layout(rect=(0, 0.12, 1, 1))
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success")
        manifest = initial["figures"][0]["manifest"]
        objects = manifest["objects"]

        legend = next(o for o in objects if o["id"] == "legend.figure.0")
        legend_title = next(o for o in objects if o["id"] == "legend_title.figure.0")
        legend_texts = [o for o in objects if o["id"].startswith("legend_text.figure.0.")]
        legend_lines = [o for o in objects if o["id"].startswith("legend_line.figure.0.")]
        unsupported_legend_count = sum(
            item.get("count", 0)
            for item in manifest.get("coverageReport", {}).get("unsupportedArtists", [])
            if item.get("class") == "Legend"
        )

        self.assertEqual(legend["kind"], "legend")
        self.assertEqual(legend["role"], "legend")
        self.assertIn("position", legend["editable"])
        self.assertEqual(legend["identity"]["scope"], "figure")
        self.assertNotIn("subplotId", legend["identity"].get("relation", {}))
        self.assertEqual(legend_title["role"], "legend_text")
        self.assertEqual(legend_title["identity"]["relation"]["legendId"], "legend.figure.0")
        self.assertNotIn("subplotId", legend_title["identity"]["relation"])
        self.assertEqual(len(legend_texts), 2)
        self.assertEqual([o["currentProps"]["text"] for o in legend_texts], ["Promoted", "Suppressed"])
        self.assertEqual(len(legend_lines), 2)
        self.assertEqual(unsupported_legend_count, 0)

        patched = replay_render(script, edit_log=[
            {
                "gid": "legend.figure.0",
                "prop": "position",
                "value": {"x": 0.52, "y": 0.08, "coord_system": "figure"},
                "mode": "backend_patch",
            },
            {
                "gid": "legend_text.figure.0.0",
                "prop": "fontsize",
                "value": 13,
                "mode": "backend_patch",
            },
        ])
        self.assertEqual(patched.get("status"), "success")
        patched_objects = patched["figures"][0]["manifest"]["objects"]
        patched_legend = next(o for o in patched_objects if o["id"] == "legend.figure.0")
        patched_text = next(o for o in patched_objects if o["id"] == "legend_text.figure.0.0")

        self.assertAlmostEqual(patched_legend["currentProps"]["x"], 0.52, places=2)
        self.assertAlmostEqual(patched_legend["currentProps"]["y"], 0.08, places=2)
        self.assertEqual(patched_text["currentProps"]["fontsize"], 13)

    def test_twin_and_shared_axes_have_explicit_symmetric_relationships(self):
        twin_result = replay_render("""
import matplotlib.pyplot as plt
fig, left = plt.subplots()
right = left.twinx()
left.plot([0, 1], [1, 2])
right.plot([0, 1], [10, 20])
""")
        self.assertEqual(twin_result.get("status"), "success")
        twin_objects = {obj["id"]: obj for obj in twin_result["figures"][0]["manifest"]["objects"]}
        left_relation = twin_objects["subplot.0"]["identity"]["relation"]
        right_relation = twin_objects["subplot.1"]["identity"]["relation"]
        self.assertEqual(left_relation["twinSubplotIds"], ["subplot.1"])
        self.assertEqual(right_relation["twinSubplotIds"], ["subplot.0"])
        self.assertEqual(left_relation["sharedXSubplotIds"], ["subplot.1"])
        self.assertEqual(right_relation["sharedXSubplotIds"], ["subplot.0"])
        self.assertNotIn("sharedYSubplotIds", left_relation)
        self.assertNotIn("sharedYSubplotIds", right_relation)

        patched_twin = replay_render("""
import matplotlib.pyplot as plt
fig, left = plt.subplots()
right = left.twinx()
left.plot([0, 1], [1, 2])
right.plot([0, 1], [10, 20])
""", edit_log=[
            {"gid": "axis.y.1", "prop": "label_color", "value": "#cc2255", "mode": "backend_patch"},
        ])
        self.assertEqual(patched_twin.get("status"), "success")
        patched_twin_objects = {obj["id"]: obj for obj in patched_twin["figures"][0]["manifest"]["objects"]}
        self.assertEqual(patched_twin_objects["axis.y.1"]["currentProps"]["label_color"].lower(), "#cc2255")
        self.assertNotEqual(patched_twin_objects["axis.y.0"]["currentProps"]["label_color"].lower(), "#cc2255")
        self.assertEqual(
            patched_twin_objects["subplot.0"]["identity"]["relation"]["twinSubplotIds"],
            ["subplot.1"],
        )

        shared_result = replay_render("""
import matplotlib.pyplot as plt
fig, axes = plt.subplots(2, 2, sharex='col', sharey='row')
for index, ax in enumerate(axes.flat):
    ax.plot([0, 1], [index, index + 1])
""")
        self.assertEqual(shared_result.get("status"), "success")
        shared_objects = {obj["id"]: obj for obj in shared_result["figures"][0]["manifest"]["objects"]}
        top_left = shared_objects["subplot.0"]["identity"]["relation"]
        self.assertEqual(top_left["sharedXSubplotIds"], ["subplot.2"])
        self.assertEqual(top_left["sharedYSubplotIds"], ["subplot.1"])
        self.assertNotIn("twinSubplotIds", top_left)
        self.assertEqual(
            shared_objects["subplot.2"]["identity"]["relation"]["sharedXSubplotIds"],
            ["subplot.0"],
        )
        self.assertEqual(
            shared_objects["subplot.1"]["identity"]["relation"]["sharedYSubplotIds"],
            ["subplot.0"],
        )

    def test_replay_render_reports_monotonic_timing_breakdown(self):
        result = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
ax.set_title("Timing")
""")
        self.assertEqual(result.get("status"), "success")
        timing = result.get("timingBreakdown", {})
        expected_keys = {
            "staticScanMs",
            "scriptExecutionMs",
            "dynamicScanMs",
            "figureDiscoveryMs",
            "editApplyMs",
            "introspectionMs",
            "svgSerializeMs",
            "binaryExportMs",
            "totalMs",
        }
        self.assertTrue(expected_keys.issubset(timing.keys()))
        self.assertTrue(all(isinstance(timing[key], int) and timing[key] >= 0 for key in expected_keys))
        self.assertEqual(result["timingMs"], timing["totalMs"])
        self.assertGreaterEqual(timing["totalMs"], timing["svgSerializeMs"])

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

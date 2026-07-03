import os
import sys
import json
import unittest

# Ensure the renderer directory is in the Python search path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render

class TestArtistIntrospection(unittest.TestCase):
    
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

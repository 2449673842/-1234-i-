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

if __name__ == "__main__":
    unittest.main()

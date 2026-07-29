import os
import sys
import unittest
import xml.etree.ElementTree as ET


project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render  # noqa: E402


RADAR_FIXTURE = r"""
import numpy as np
import matplotlib.pyplot as plt

labels = ["Quality", "Speed", "Cost", "Reliability"]
values = np.array([0.82, 0.64, 0.48, 0.91])
values_b = np.array([0.58, 0.79, 0.72, 0.55])
angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)
angles_closed = np.r_[angles, angles[0]]
values_closed = np.r_[values, values[0]]
values_b_closed = np.r_[values_b, values_b[0]]

fig, ax = plt.subplots(figsize=(4, 4), subplot_kw={"projection": "polar"})
fig.subplots_adjust(left=0.20, right=0.80, bottom=0.20, top=0.80)
ax.set_ylim(0, 1)
ax.set_xticks(angles)
ax.set_xticklabels(labels)
ax.plot(
    angles_closed,
    values_closed,
    color="#3366cc",
    linewidth=2.0,
    label="Model A",
)
ax.fill(
    angles_closed,
    values_closed,
    color="#3366cc",
    alpha=0.25,
)
ax.plot(
    angles_closed,
    values_b_closed,
    color="#dd5544",
    linewidth=2.0,
    label="Model B",
)
ax.fill(
    angles_closed,
    values_b_closed,
    color="#dd5544",
    alpha=0.18,
)
ax.text(
    0.5,
    0.94,
    "Radar note",
    transform=ax.transAxes,
    ha="center",
    va="center",
    bbox={
        "boxstyle": "round,pad=0.30",
        "facecolor": "#ffeeaa",
        "edgecolor": "#333333",
        "alpha": 0.8,
        "linewidth": 1.2,
    },
)
ax.legend(loc="center", bbox_to_anchor=(0.78, 0.82))
"""


class TestRadarChartSpecialization(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._close_all_figures()

    def tearDown(self):
        self._close_all_figures()

    def _close_all_figures(self):
        try:
            import matplotlib.pyplot as plt

            plt.close("all")
        except Exception:
            pass

    def _render(self, edit_log=None):
        result = replay_render(RADAR_FIXTURE, edit_log=edit_log)
        self.assertEqual(result.get("status"), "success", result)
        figures = result.get("figures", [])
        self.assertEqual(len(figures), 1, result)
        manifest = figures[0].get("manifest", {})
        self.assertTrue(manifest.get("objects"), manifest)
        return result, manifest

    def _objects_by_id(self, manifest):
        return {obj.get("id"): obj for obj in manifest.get("objects", [])}

    def _objects_with_prefix(self, manifest, prefix):
        return [
            obj
            for obj in manifest.get("objects", [])
            if str(obj.get("id", "")).startswith(prefix)
        ]

    def _capability_props(self, obj):
        return {capability.get("prop") for capability in obj.get("propertyCapabilities", [])}

    def _assert_no_warnings(self, result):
        self.assertFalse(result.get("warnings"), result.get("warnings"))
        self.assertFalse(result.get("determinismWarnings"), result.get("determinismWarnings"))
        self.assertFalse(result.get("layoutWarnings"), result.get("layoutWarnings"))
        for figure in result.get("figures", []):
            self.assertFalse(figure.get("layoutWarnings"), figure.get("layoutWarnings"))

    def _dimension_label(self, manifest, text="Quality"):
        labels = [
            obj
            for obj in self._objects_with_prefix(manifest, "xtick.")
            if obj.get("currentProps", {}).get("text") == text
        ]
        self.assertEqual(len(labels), 1, labels)
        return labels[0]

    def _plain_note_text(self, manifest):
        notes = [
            obj
            for obj in self._objects_with_prefix(manifest, "text.")
            if obj.get("currentProps", {}).get("text") == "Radar note"
        ]
        self.assertEqual(len(notes), 1, notes)
        return notes[0]

    def _svg_text_position(self, svg, gid):
        root = ET.fromstring(svg)
        target = next(
            (element for element in root.iter() if element.get("id") == gid),
            None,
        )
        self.assertIsNotNone(target, gid)
        text = next(
            (element for element in target.iter() if element.tag.endswith("}text")),
            None,
        )
        self.assertIsNotNone(text, gid)
        return float(text.get("x")), float(text.get("y"))

    def test_exposes_polar_panel_for_radar_chart(self):
        _, manifest = self._render()
        panel = self._objects_by_id(manifest).get("polar_subplot.0")

        self.assertIsNotNone(panel, manifest.get("objects"))
        self.assertEqual(panel.get("kind"), "polar_subplot")
        self.assertEqual(panel.get("role"), "polar_subplot_panel")
        self.assertEqual(panel.get("currentProps", {}).get("projection"), "polar")

    def test_does_not_classify_closed_periodic_polar_curve_as_radar(self):
        script = r"""
import numpy as np
import matplotlib.pyplot as plt

theta = np.linspace(0, 2 * np.pi, 181)
radius = 1.0 + 0.2 * np.cos(3 * theta)
fig, ax = plt.subplots(subplot_kw={"projection": "polar"})
ax.set_xticks(np.linspace(0, 2 * np.pi, 8, endpoint=False))
ax.set_xticklabels(["0", "45", "90", "135", "180", "225", "270", "315"])
ax.plot(theta, radius, label="Periodic response")
ax.legend()
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        manifest = result["figures"][0]["manifest"]
        objects = self._objects_by_id(manifest)

        line = objects["line.0.0"]
        legend = objects["legend.0"]
        labels = self._objects_with_prefix(manifest, "xtick.")
        self.assertNotIn("radarSemanticRole", line.get("currentProps", {}))
        self.assertNotIn("position", legend.get("editable", []))
        self.assertTrue(labels)
        self.assertTrue(all("radar_label_offset" not in label.get("editable", []) for label in labels))

    def test_marks_xtick_dimension_labels_with_radar_offset_capability(self):
        _, manifest = self._render()
        label = self._dimension_label(manifest)

        self.assertEqual(
            label.get("currentProps", {}).get("radarSemanticRole"),
            "dimension_label",
        )
        self.assertIn("radar_label_offset", label.get("editable", []))
        self.assertIn("radar_label_offset", self._capability_props(label))

    def test_marks_radar_line_with_series_role(self):
        _, manifest = self._render()
        lines = [
            obj
            for obj in self._objects_with_prefix(manifest, "line.")
            if obj.get("label") == "Model A"
        ]
        self.assertEqual(len(lines), 1, lines)

        self.assertEqual(lines[0].get("currentProps", {}).get("radarSemanticRole"), "series")

    def test_marks_radar_polygon_with_fill_role(self):
        _, manifest = self._render()
        fills = [
            obj
            for obj in self._objects_with_prefix(manifest, "patch.")
            if obj.get("currentProps", {}).get("alpha") == 0.25
        ]
        self.assertEqual(len(fills), 1, fills)

        self.assertEqual(fills[0].get("currentProps", {}).get("radarSemanticRole"), "fill")

    def test_pairs_each_radar_line_and_fill_without_series_collision(self):
        _, manifest = self._render()
        series_objects = [
            obj
            for obj in manifest.get("objects", [])
            if obj.get("currentProps", {}).get("radarSemanticRole") in {"series", "fill"}
        ]
        by_series = {}
        for obj in series_objects:
            series_id = obj.get("currentProps", {}).get("radarSeriesId")
            by_series.setdefault(series_id, set()).add(obj.get("currentProps", {}).get("radarSemanticRole"))
            self.assertEqual(obj.get("identity", {}).get("relation", {}).get("radarSeriesId"), series_id)

        self.assertEqual(len(by_series), 2, by_series)
        self.assertTrue(all(roles == {"series", "fill"} for roles in by_series.values()), by_series)

    def test_keeps_legend_container_position_editable(self):
        _, manifest = self._render()
        legend = self._objects_by_id(manifest).get("legend.0")

        self.assertIsNotNone(legend, manifest.get("objects"))
        self.assertIn("position", legend.get("editable", []))
        self.assertIn("position", self._capability_props(legend))
        self.assertEqual(legend.get("currentProps", {}).get("coord_system"), "figure")
        self.assertIsInstance(legend.get("currentProps", {}).get("x"), float)
        self.assertIsInstance(legend.get("currentProps", {}).get("y"), float)

    def test_keeps_legend_text_editable(self):
        _, manifest = self._render()
        legend_text = self._objects_by_id(manifest).get("legend_text.0.0")

        self.assertIsNotNone(legend_text, manifest.get("objects"))
        self.assertIn("text", legend_text.get("editable", []))
        self.assertIn("text", self._capability_props(legend_text))

    def test_keeps_radar_legend_relation_after_text_edit(self):
        edit_log = [{
            "gid": "legend_text.0.0",
            "prop": "text",
            "value": "Model A edited",
            "mode": "backend_patch",
        }]

        result, manifest = self._render(edit_log=edit_log)

        self._assert_no_warnings(result)
        legend_text = self._objects_by_id(manifest)["legend_text.0.0"]
        self.assertEqual(legend_text["currentProps"]["text"], "Model A edited")
        self.assertEqual(legend_text["currentProps"]["radarSemanticRole"], "legend_text")
        self.assertEqual(legend_text["currentProps"]["radarSeriesId"], "radar.0.series.0")

    def test_maps_mixed_legend_entries_only_to_matching_radar_series(self):
        script = r"""
import numpy as np
import matplotlib.pyplot as plt

labels = ["Quality", "Speed", "Cost", "Reliability"]
angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)
angles_closed = np.r_[angles, angles[0]]
values = np.array([0.82, 0.64, 0.48, 0.91])
theta = np.linspace(0, 2 * np.pi, 181)

fig, ax = plt.subplots(subplot_kw={"projection": "polar"})
ax.set_xticks(angles)
ax.set_xticklabels(labels)
ax.plot(theta, 0.25 + 0.04 * np.cos(3 * theta), color="#777777", linestyle="--", label="Reference")
ax.plot(angles_closed, np.r_[values, values[0]], color="#3366cc", linewidth=2.0, label="Model A")
ax.fill(angles_closed, np.r_[values, values[0]], color="#3366cc", alpha=0.25)
ax.legend()
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        objects = self._objects_by_id(result["figures"][0]["manifest"])

        reference_text = objects["legend_text.0.0"]
        radar_text = objects["legend_text.0.1"]
        self.assertNotIn("radarSemanticRole", reference_text.get("currentProps", {}))
        self.assertNotIn("radarSeriesId", reference_text.get("currentProps", {}))
        self.assertEqual(radar_text["currentProps"]["radarSemanticRole"], "legend_text")
        self.assertEqual(radar_text["currentProps"]["radarSeriesId"], "radar.0.series.0")

    def test_does_not_guess_mixed_legend_relation_when_line_styles_collide(self):
        script = r"""
import numpy as np
import matplotlib.pyplot as plt

labels = ["Quality", "Speed", "Cost", "Reliability"]
angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)
angles_closed = np.r_[angles, angles[0]]
values = np.array([0.82, 0.64, 0.48, 0.91])
theta = np.linspace(0, 2 * np.pi, 181)

fig, ax = plt.subplots(subplot_kw={"projection": "polar"})
ax.set_xticks(angles)
ax.set_xticklabels(labels)
ax.plot(theta, 0.25 + 0.04 * np.cos(3 * theta), color="#3366cc", linewidth=2.0, label="Reference")
ax.plot(angles_closed, np.r_[values, values[0]], color="#3366cc", linewidth=2.0, label="Model A")
ax.fill(angles_closed, np.r_[values, values[0]], color="#3366cc", alpha=0.25)
ax.legend()
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        objects = self._objects_by_id(result["figures"][0]["manifest"])

        for legend_gid in ("legend_text.0.0", "legend_text.0.1"):
            props = objects[legend_gid].get("currentProps", {})
            self.assertNotIn("radarSemanticRole", props)
            self.assertNotIn("radarSeriesId", props)

    def test_exposes_plain_text_bbox_properties(self):
        _, manifest = self._render()
        note = self._plain_note_text(manifest)
        expected_props = {
            "bbox_visible",
            "bbox_facecolor",
            "bbox_edgecolor",
            "bbox_alpha",
            "bbox_linewidth",
            "bbox_pad",
            "bbox_boxstyle",
        }

        self.assertLessEqual(expected_props, set(note.get("editable", [])))
        self.assertLessEqual(expected_props, self._capability_props(note))
        self.assertEqual(note.get("currentProps", {}).get("bbox_visible"), True)

    def test_replays_radar_dimension_label_offset_without_warnings_and_updates_manifest(self):
        baseline_result, baseline = self._render()
        label = self._dimension_label(baseline)
        edit_log = [{
            "gid": label["id"],
            "prop": "radar_label_offset",
            "value": {"dx": 8.0, "dy": -3.5},
            "mode": "backend_patch",
        }]

        result, manifest = self._render(edit_log=edit_log)

        self._assert_no_warnings(result)
        patched = self._objects_by_id(manifest)[label["id"]]
        self.assertAlmostEqual(patched["currentProps"]["radar_label_offset"]["dx"], 8.0, places=4)
        self.assertAlmostEqual(patched["currentProps"]["radar_label_offset"]["dy"], -3.5, places=4)
        baseline_x, baseline_y = self._svg_text_position(baseline_result["svg"], label["id"])
        patched_x, patched_y = self._svg_text_position(result["svg"], label["id"])
        self.assertAlmostEqual(patched_x - baseline_x, 8.0, places=3)
        self.assertAlmostEqual(patched_y - baseline_y, 3.5, places=3)

    def test_replays_legend_position_without_warnings_and_updates_manifest(self):
        edit_log = [{
            "gid": "legend.0",
            "prop": "position",
            "value": {"x": 0.70, "y": 0.76, "coord_system": "figure"},
            "mode": "backend_patch",
        }]

        result, manifest = self._render(edit_log=edit_log)

        self._assert_no_warnings(result)
        position = self._objects_by_id(manifest)["legend.0"]["currentProps"]
        self.assertAlmostEqual(position["x"], 0.70, places=2)
        self.assertAlmostEqual(position["y"], 0.76, places=2)
        self.assertEqual(position["coord_system"], "figure")

    def test_replays_identity_backed_legend_position_after_prior_radar_edits(self):
        _, baseline = self._render()
        objects = self._objects_by_id(baseline)
        legend = objects["legend.0"]
        legend_text = objects["legend_text.0.0"]
        edit_log = [
            {
                "gid": legend_text["id"],
                "prop": "text",
                "value": "Model A edited",
                "mode": "backend_patch",
                "stableKey": legend_text["stableKey"],
                "fingerprint": legend_text["fingerprint"],
                "fingerprintVersion": legend_text["fingerprintVersion"],
                "identity": legend_text["identity"],
            },
            {
                "gid": legend["id"],
                "prop": "position",
                "value": {"x": 0.63, "y": 0.66, "coord_system": "figure"},
                "mode": "backend_patch",
                "stableKey": legend["stableKey"],
                "fingerprint": legend["fingerprint"],
                "fingerprintVersion": legend["fingerprintVersion"],
                "identity": legend["identity"],
            },
        ]

        result, manifest = self._render(edit_log=edit_log)

        self._assert_no_warnings(result)
        replayed = self._objects_by_id(manifest)
        self.assertEqual(replayed[legend_text["id"]]["currentProps"]["text"], "Model A edited")
        self.assertAlmostEqual(replayed[legend["id"]]["currentProps"]["x"], 0.63, places=2)
        self.assertAlmostEqual(replayed[legend["id"]]["currentProps"]["y"], 0.66, places=2)

    def test_replays_text_bbox_without_warnings_and_updates_manifest(self):
        _, baseline = self._render()
        note = self._plain_note_text(baseline)
        edit_log = [
            {
                "gid": note["id"],
                "prop": "bbox_facecolor",
                "value": "#ddeeff",
                "mode": "backend_patch",
            },
            {
                "gid": note["id"],
                "prop": "bbox_edgecolor",
                "value": "#112233",
                "mode": "backend_patch",
            },
            {
                "gid": note["id"],
                "prop": "bbox_alpha",
                "value": 0.55,
                "mode": "backend_patch",
            },
            {
                "gid": note["id"],
                "prop": "bbox_linewidth",
                "value": 2.4,
                "mode": "backend_patch",
            },
            {
                "gid": note["id"],
                "prop": "bbox_pad",
                "value": 0.5,
                "mode": "backend_patch",
            },
            {
                "gid": note["id"],
                "prop": "bbox_boxstyle",
                "value": "round",
                "mode": "backend_patch",
            },
        ]

        result, manifest = self._render(edit_log=edit_log)

        self._assert_no_warnings(result)
        patched_props = self._objects_by_id(manifest)[note["id"]]["currentProps"]
        self.assertEqual(patched_props["bbox_facecolor"].lower(), "#ddeeff")
        self.assertEqual(patched_props["bbox_edgecolor"].lower(), "#112233")
        self.assertAlmostEqual(patched_props["bbox_alpha"], 0.55, places=4)
        self.assertAlmostEqual(patched_props["bbox_linewidth"], 2.4, places=4)
        self.assertAlmostEqual(patched_props["bbox_pad"], 0.5, places=4)
        self.assertEqual(patched_props["bbox_boxstyle"], "round")


if __name__ == "__main__":
    unittest.main()

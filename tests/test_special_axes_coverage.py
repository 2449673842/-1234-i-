import importlib.util
import copy
import os
import sys
import unittest


project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render  # noqa: E402


UNSAFE_LAYOUT_PROPS = {
    "left",
    "bottom",
    "width",
    "height",
    "position",
    "aspect",
    "box_aspect",
}

UNSAFE_3D_STRUCTURAL_PROPS = {
    "azim",
    "elev",
    "roll",
    "dist",
    "proj_type",
    "projection",
    "box_aspect",
    "camera",
}


class TestSpecialAxesCoverage(unittest.TestCase):
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

    def _render_manifest(self, script):
        try:
            result = replay_render(script)
        except Exception as exc:  # pragma: no cover - intentionally converted to fail-first evidence
            self.fail(
                "special axes introspection must safely degrade without raising: "
                f"{type(exc).__name__}: {exc}"
            )
        self.assertEqual(result.get("status"), "success", result)
        figures = result.get("figures", [])
        self.assertEqual(len(figures), 1, result)
        manifest = figures[0].get("manifest", {})
        self.assertTrue(manifest.get("objects"), manifest)
        return manifest

    def _objects_by_id(self, manifest):
        return {obj.get("id"): obj for obj in manifest.get("objects", [])}

    def _object_summary(self, objects):
        return [
            {
                "id": obj.get("id"),
                "kind": obj.get("kind"),
                "role": obj.get("role"),
                "artistClass": obj.get("source", {}).get("artistClass"),
            }
            for obj in objects.values()
        ]

    def _ordinary_data_subplots(self, manifest):
        return [
            obj
            for obj in manifest.get("objects", [])
            if obj.get("kind") == "subplot" and obj.get("role") == "subplot_panel"
        ]

    def _capability_props(self, obj):
        return {item.get("prop") for item in obj.get("propertyCapabilities", [])}

    def _assert_props_not_exposed(self, obj, props):
        editable = set(obj.get("editable") or [])
        capability_props = self._capability_props(obj)
        self.assertFalse(editable & props, obj)
        self.assertFalse(capability_props & props, obj)

    def _assert_parent_relation_or_safe_mark(self, obj, expected_parent_id):
        relation = obj.get("identity", {}).get("relation", {})
        safe_reason = (
            obj.get("currentProps", {}).get("specialAxesUnsupportedReason")
            or obj.get("currentProps", {}).get("unsupportedReason")
            or obj.get("currentProps", {}).get("degradedReason")
        )
        self.assertTrue(
            relation.get("parentSubplotId") == expected_parent_id
            or relation.get("ownerSubplotId") == expected_parent_id
            or relation.get("subplotId") == expected_parent_id
            or bool(safe_reason),
            obj,
        )

    def _assert_complete_axes_relation(self, obj, axes_family, projection):
        relation = obj.get("identity", {}).get("relation", {})
        self.assertEqual(relation.get("axesFamily"), axes_family, obj)
        self.assertEqual(relation.get("projection"), projection, obj)
        for field in ("parentSubplotId", "ownerSubplotId"):
            self.assertIsInstance(relation.get(field), str, obj)
            self.assertTrue(relation[field], obj)

    def test_polar_axes_are_distinct_from_cartesian_and_layout_readonly(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig = plt.figure()
ax = fig.add_subplot(111, projection="polar")
ax.plot([0.0, 0.7, 1.4], [1.0, 2.0, 1.5], label="polar response")
ax.set_title("Polar panel")
"""
        )
        objects = self._objects_by_id(manifest)

        polar = objects.get("polar_subplot.0")
        self.assertIsNotNone(polar, self._object_summary(objects))
        self.assertEqual(polar.get("kind"), "polar_subplot")
        self.assertEqual(polar.get("role"), "polar_subplot_panel")
        self.assertEqual(polar.get("currentProps", {}).get("projection"), "polar")
        self.assertNotEqual(polar.get("role"), "subplot_panel")
        self.assertNotEqual(polar.get("kind"), "subplot")
        self._assert_complete_axes_relation(polar, "polar", "polar")
        self._assert_props_not_exposed(polar, UNSAFE_LAYOUT_PROPS)

    def test_3d_axes_are_distinct_and_camera_projection_edits_are_readonly(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig = plt.figure()
ax = fig.add_subplot(111, projection="3d")
ax.plot([0, 1, 2], [0, 1, 0], [1, 2, 3], label="trajectory")
ax.view_init(elev=25, azim=35)
"""
        )
        objects = self._objects_by_id(manifest)

        axes_3d = objects.get("three_d_subplot.0")
        self.assertIsNotNone(axes_3d, self._object_summary(objects))
        self.assertEqual(axes_3d.get("kind"), "three_d_subplot")
        self.assertEqual(axes_3d.get("role"), "three_d_subplot_panel")
        self.assertEqual(axes_3d.get("currentProps", {}).get("projection"), "3d")
        self.assertNotEqual(axes_3d.get("role"), "subplot_panel")
        self.assertNotEqual(axes_3d.get("kind"), "subplot")
        self._assert_complete_axes_relation(axes_3d, "3d", "3d")
        self._assert_props_not_exposed(axes_3d, UNSAFE_LAYOUT_PROPS | UNSAFE_3D_STRUCTURAL_PROPS)
        self.assertFalse(axes_3d.get("currentProps", {}).get("cameraEditable", True), axes_3d)
        self.assertFalse(axes_3d.get("currentProps", {}).get("projectionEditable", True), axes_3d)
        z_axis = objects.get("axis.z.0")
        self.assertIsNotNone(z_axis, self._object_summary(objects))
        self._assert_props_not_exposed(z_axis, {"limits", "position", "projection", "camera"})
        self.assertIn("tick_labelsize", z_axis.get("editable", []), z_axis)

    def test_inset_axes_are_related_to_parent_or_safely_marked(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2], label="main")
inset = ax.inset_axes([0.58, 0.55, 0.32, 0.32])
inset.plot([0, 1, 2], [2, 1, 2], label="inset")
inset.set_title("Inset")
"""
        )
        objects = self._objects_by_id(manifest)
        ordinary_subplots = self._ordinary_data_subplots(manifest)
        self.assertEqual(
            [obj.get("id") for obj in ordinary_subplots],
            ["subplot.0"],
            self._object_summary(objects),
        )

        inset = objects.get("inset_subplot.0")
        self.assertIsNotNone(inset, self._object_summary(objects))
        self.assertEqual(inset.get("kind"), "inset_subplot")
        self.assertEqual(inset.get("role"), "inset_subplot_panel")
        self._assert_complete_axes_relation(inset, "inset", "rectilinear")
        self._assert_parent_relation_or_safe_mark(inset, "subplot.0")
        self.assertNotEqual(inset.get("role"), "subplot_panel")
        self._assert_props_not_exposed(inset, UNSAFE_LAYOUT_PROPS)

    def test_secondary_axes_are_not_ordinary_subplots_and_retain_parent_relation(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 3, 2])
secx = ax.secondary_xaxis("top", functions=(lambda x: x * 2, lambda x: x / 2))
secy = ax.secondary_yaxis("right", functions=(lambda y: y + 10, lambda y: y - 10))
secx.set_xlabel("double x")
secy.set_ylabel("offset y")
"""
        )
        objects = self._objects_by_id(manifest)
        ordinary_subplots = self._ordinary_data_subplots(manifest)
        self.assertEqual(
            [obj.get("id") for obj in ordinary_subplots],
            ["subplot.0"],
            self._object_summary(objects),
        )

        secondary_x = objects.get("secondary_xaxis.0")
        secondary_y = objects.get("secondary_yaxis.0")
        self.assertIsNotNone(secondary_x, self._object_summary(objects))
        self.assertIsNotNone(secondary_y, self._object_summary(objects))
        self.assertNotEqual(secondary_x.get("kind"), "subplot")
        self.assertNotEqual(secondary_y.get("kind"), "subplot")
        self.assertEqual(secondary_x.get("role"), "secondary_x_axis")
        self.assertEqual(secondary_y.get("role"), "secondary_y_axis")
        self._assert_complete_axes_relation(secondary_x, "secondary_x", "rectilinear")
        self._assert_complete_axes_relation(secondary_y, "secondary_y", "rectilinear")
        self._assert_parent_relation_or_safe_mark(secondary_x, "subplot.0")
        self._assert_parent_relation_or_safe_mark(secondary_y, "subplot.0")

    def test_parasite_axes_retain_host_relation_and_remain_readonly(self):
        manifest = self._render_manifest(
            """
from mpl_toolkits.axes_grid1 import host_subplot
from mpl_toolkits import axisartist
import matplotlib.pyplot as plt
fig = plt.figure()
host = host_subplot(111, axes_class=axisartist.Axes, figure=fig)
parasite = host.twinx()
host.plot([0, 1], [1, 2], color="blue")
parasite.plot([0, 1], [2, 1], color="red")
"""
        )
        objects = self._objects_by_id(manifest)
        self.assertEqual(
            self._ordinary_data_subplots(manifest),
            [],
            self._object_summary(objects),
        )

        host = objects.get("parasite_subplot.0")
        parasite = objects.get("parasite_axis.0")
        self.assertIsNotNone(host, self._object_summary(objects))
        self.assertIsNotNone(parasite, self._object_summary(objects))
        self.assertEqual(host.get("role"), "parasite_host_panel")
        self.assertEqual(parasite.get("role"), "parasite_axis")
        self._assert_complete_axes_relation(host, "parasite_host", "rectilinear")
        self._assert_complete_axes_relation(parasite, "parasite", "rectilinear")
        self._assert_parent_relation_or_safe_mark(parasite, host.get("id"))
        self.assertEqual(host.get("editable"), [], host)
        self.assertEqual(parasite.get("editable"), [], parasite)
        self.assertEqual(self._capability_props(host), set(), host)
        self.assertEqual(self._capability_props(parasite), set(), parasite)

        host_line = objects.get("line.0.0")
        parasite_line = objects.get("line.1.0")
        self.assertIsNotNone(host_line, self._object_summary(objects))
        self.assertIsNotNone(parasite_line, self._object_summary(objects))
        self._assert_parent_relation_or_safe_mark(host_line, host.get("id"))
        self._assert_parent_relation_or_safe_mark(parasite_line, host.get("id"))
        self.assertEqual(host_line.get("editable"), [], host_line)
        self.assertEqual(parasite_line.get("editable"), [], parasite_line)

    def test_malformed_custom_projection_safely_degrades(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.projections import register_projection

class BrokenProjection(Axes):
    name = "broken_projection_for_wp7"

    def get_position(self, *args, **kwargs):
        raise RuntimeError("broken projection position")

register_projection(BrokenProjection)
fig = plt.figure()
ax = fig.add_subplot(111, projection="broken_projection_for_wp7")
ax.plot([0, 1], [1, 2])
"""
        )
        objects = self._objects_by_id(manifest)

        degraded = objects.get("unsupported_axes.0")
        self.assertIsNotNone(degraded, self._object_summary(objects))
        self.assertEqual(degraded.get("kind"), "unsupported_axes")
        self.assertEqual(degraded.get("role"), "unsupported_projection_panel")
        self.assertEqual(
            degraded.get("currentProps", {}).get("projection"),
            "broken_projection_for_wp7",
        )
        self.assertTrue(
            degraded.get("currentProps", {}).get("degradedReason")
            or degraded.get("currentProps", {}).get("specialAxesUnsupportedReason"),
            degraded,
        )
        self._assert_complete_axes_relation(
            degraded,
            "unsupported",
            "broken_projection_for_wp7",
        )
        self._assert_props_not_exposed(degraded, UNSAFE_LAYOUT_PROPS)

    def test_brokenaxes_named_projection_uses_readonly_group_contract(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.projections import register_projection

class BrokenAxes(Axes):
    name = "synthetic_brokenaxes"

register_projection(BrokenAxes)
fig = plt.figure()
ax = fig.add_subplot(111, projection="synthetic_brokenaxes")
ax.plot([0, 1], [1, 2])
"""
        )
        objects = self._objects_by_id(manifest)

        broken = objects.get("brokenaxes_group.0")
        self.assertIsNotNone(broken, self._object_summary(objects))
        self.assertEqual(broken.get("kind"), "brokenaxes_group")
        self.assertEqual(broken.get("role"), "brokenaxes_panel_group")
        self._assert_complete_axes_relation(broken, "broken", "synthetic_brokenaxes")
        self.assertEqual(broken.get("editable"), [], broken)
        self.assertEqual(self._capability_props(broken), set(), broken)
        self._assert_props_not_exposed(broken, UNSAFE_LAYOUT_PROPS)

    def test_special_axes_relation_drift_is_rejected_without_breaking_legacy_logs(self):
        script = """
import matplotlib.pyplot as plt
fig = plt.figure()
ax = fig.add_subplot(111, projection="polar")
ax.plot([0.0, 0.7, 1.4], [1.0, 2.0, 1.5], color="#1f77b4", label="polar response")
"""
        baseline = replay_render(script)
        baseline_line = next(
            obj
            for obj in baseline["figures"][0]["manifest"]["objects"]
            if obj.get("id") == "line.0.0"
        )
        bad_identity = copy.deepcopy(baseline_line["identity"])
        bad_identity["relation"]["axesFamily"] = "3d"
        rejected = replay_render(script, edit_log=[{
            "gid": baseline_line["id"],
            "prop": "color",
            "value": "#ff0000",
            "mode": "backend_patch",
            "stableKey": baseline_line["stableKey"],
            "fingerprint": baseline_line["fingerprint"],
            "fingerprintVersion": 2,
            "identity": bad_identity,
        }])
        rejected_line = next(
            obj
            for obj in rejected["figures"][0]["manifest"]["objects"]
            if obj.get("id") == "line.0.0"
        )
        self.assertEqual(rejected_line["currentProps"]["color"].lower(), "#1f77b4")
        self.assertTrue(any(
            warning.get("type") == "identity_mismatch"
            and "identity.relation.axesFamily" in warning.get("mismatches", [])
            for warning in rejected.get("warnings", [])
            if isinstance(warning, dict)
        ), rejected)

        legacy = replay_render(script, edit_log=[{
            "gid": baseline_line["id"],
            "prop": "color",
            "value": "#00aa55",
            "mode": "backend_patch",
            "stableKey": baseline_line["stableKey"],
        }])
        legacy_line = next(
            obj
            for obj in legacy["figures"][0]["manifest"]["objects"]
            if obj.get("id") == "line.0.0"
        )
        self.assertEqual(legacy_line["currentProps"]["color"].lower(), "#00aa55")

    @unittest.skipUnless(importlib.util.find_spec("cartopy"), "cartopy is not installed")
    def test_cartopy_geoaxes_are_not_plain_cartesian_subplots(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
fig = plt.figure()
ax = fig.add_subplot(111, projection=ccrs.PlateCarree())
ax.coastlines()
ax.set_global()
"""
        )
        objects = self._objects_by_id(manifest)

        geo = objects.get("geo_subplot.0")
        self.assertIsNotNone(geo, self._object_summary(objects))
        self.assertEqual(geo.get("kind"), "geo_subplot")
        self.assertEqual(geo.get("role"), "geo_subplot_panel")
        self.assertNotEqual(geo.get("kind"), "subplot")
        self.assertNotEqual(geo.get("role"), "subplot_panel")
        self._assert_props_not_exposed(geo, UNSAFE_LAYOUT_PROPS)

    @unittest.skipUnless(importlib.util.find_spec("brokenaxes"), "brokenaxes is not installed")
    def test_brokenaxes_children_are_related_or_safely_marked(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
from brokenaxes import brokenaxes
fig = plt.figure()
bax = brokenaxes(xlims=((0, 1), (4, 5)), hspace=.05)
bax.plot([0, 0.5, 4.5, 5.0], [1, 2, 3, 4])
"""
        )
        objects = self._objects_by_id(manifest)
        ordinary_subplots = self._ordinary_data_subplots(manifest)
        self.assertLessEqual(len(ordinary_subplots), 1, self._object_summary(objects))

        broken = objects.get("brokenaxes_group.0")
        self.assertIsNotNone(broken, self._object_summary(objects))
        self.assertEqual(broken.get("kind"), "brokenaxes_group")
        self.assertEqual(broken.get("role"), "brokenaxes_panel_group")
        for obj in objects.values():
            if obj.get("currentProps", {}).get("brokenAxesChild"):
                self._assert_parent_relation_or_safe_mark(obj, broken.get("id"))

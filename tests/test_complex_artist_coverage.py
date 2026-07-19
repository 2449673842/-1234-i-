import hashlib
import os
import sys
import unittest


project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(project_root, "renderer"))

from introspector import replay_render


STREAMPLOT_CLASSES = {"LineCollection", "FancyArrowPatch"}


class TestComplexArtistCoverage(unittest.TestCase):
    maxDiff = None

    def _render_manifest(self, script):
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        figures = result.get("figures", [])
        self.assertEqual(len(figures), 1, result)
        return figures[0]["manifest"]

    def _coverage_report(self, manifest):
        report = manifest.get("coverageReport", {})
        self.assertIn("summary", report, report)
        self.assertIn("complexArtists", report, report)
        self._assert_summary_matches_details(report)
        self._assert_details_match_object_shadow(manifest, report)
        return report

    def _complex_rows(self, manifest, classes=None):
        rows = self._coverage_report(manifest).get("complexArtists", [])
        if classes is None:
            return rows
        return [row for row in rows if row.get("class") in classes]

    def _objects_by_id(self, manifest):
        return {obj.get("id"): obj for obj in manifest.get("objects", [])}

    def _assert_summary_matches_details(self, report):
        rows = report.get("complexArtists", [])
        summary = report.get("summary", {})
        counts = {"dedicated": 0, "flattened": 0, "ambiguous": 0}
        for row in rows:
            status = row.get("status")
            self.assertIn(status, counts, row)
            counts[status] += 1
        for status, count in counts.items():
            self.assertEqual(
                summary.get(status),
                count,
                f"summary.{status} must match complexArtists rows; report={report}",
            )
        self.assertEqual(sum(counts.values()), len(rows), report)

    def _assert_details_match_object_shadow(self, manifest, report):
        objects_by_id = self._objects_by_id(manifest)
        for row in report.get("complexArtists", []):
            obj = objects_by_id.get(row.get("id"))
            self.assertIsNotNone(obj, row)
            shadow = obj.get("semanticCoverage")
            self.assertIsNotNone(shadow, obj)
            for key in (
                "family",
                "status",
                "attribution",
                "preservedKind",
                "preservedRole",
                "preservedEditable",
                "reason",
            ):
                if key in shadow or key in row:
                    self.assertEqual(row.get(key), shadow.get(key), (row, shadow))
            self.assertEqual(row.get("preservedKind"), obj.get("kind"), obj)
            self.assertEqual(row.get("preservedRole"), obj.get("role"), obj)
            self.assertEqual(row.get("preservedEditable"), obj.get("editable") or [], obj)

    def _assert_flattened_editable_reported(self, manifest, artist_class, family):
        rows = self._complex_rows(manifest, {artist_class})
        self.assertTrue(rows, f"{artist_class} not reported; coverage={manifest.get('coverageReport')}")
        objects_by_id = self._objects_by_id(manifest)
        editable_rows = []
        for row in rows:
            obj = objects_by_id[row["id"]]
            self.assertEqual(row.get("status"), "flattened", row)
            self.assertEqual(row.get("family"), family, row)
            self.assertNotIn(row.get("status"), {"dedicated"}, row)
            self.assertEqual(obj.get("semanticCoverage", {}).get("status"), "flattened", obj)
            if obj.get("editable"):
                editable_rows.append(row)
                self.assertEqual(row.get("preservedEditable"), obj.get("editable"), row)
        self.assertTrue(
            editable_rows,
            f"{artist_class} should keep generic editable controls and report them as flattened; rows={rows}",
        )

    def _assert_ambiguous_classes_not_dedicated(self, manifest, classes):
        rows = self._complex_rows(manifest, classes)
        self.assertTrue(rows, f"No ambiguous target rows for {classes}; coverage={manifest.get('coverageReport')}")
        for row in rows:
            self.assertEqual(row.get("status"), "ambiguous", row)
            self.assertIn(row.get("class"), STREAMPLOT_CLASSES, row)
            self.assertNotEqual(row.get("status"), "dedicated", row)

    def _assert_classes_not_reported(self, manifest, classes):
        rows = self._complex_rows(manifest, classes)
        self.assertEqual(rows, [], f"Generic classes must not be reported without provenance; rows={rows}")

    def _assert_no_complex_coverage(self, manifest):
        report = self._coverage_report(manifest)
        summary = report.get("summary", {})
        self.assertEqual(summary.get("flattened"), 0, report)
        self.assertEqual(summary.get("ambiguous"), 0, report)
        self.assertEqual(summary.get("dedicated"), 0, report)
        self.assertEqual(report.get("complexArtists"), [], report)

    def _capability_props(self, obj):
        return [item.get("prop") for item in obj.get("propertyCapabilities", [])]

    def _assert_visual_only_capabilities(self, obj, expected_visual_props, readonly_props):
        self.assertEqual(obj.get("editable"), expected_visual_props, obj)
        capability_props = self._capability_props(obj)
        self.assertEqual(capability_props, expected_visual_props, obj)
        for prop in readonly_props:
            self.assertNotIn(prop, obj.get("editable", []), obj)
            self.assertNotIn(prop, capability_props, obj)

    def _assert_fingerprint_stable_after_style_edit(self, script, obj, prop, value):
        capability = next(
            item for item in obj.get("propertyCapabilities", [])
            if item.get("prop") == prop
        )
        edit = {
            "gid": obj["id"],
            "prop": prop,
            "value": value,
            "mode": capability.get("patchMode", "backend_patch"),
            "stableKey": obj.get("stableKey"),
            "fingerprint": obj.get("fingerprint"),
            "fingerprintVersion": 2,
            "identity": obj.get("identity"),
        }
        replayed = replay_render(script, edit_logs={"fig_1": [edit]})
        self.assertEqual(replayed.get("status"), "success", replayed)
        self.assertEqual(replayed.get("warnings", []), [], replayed)
        replayed_obj = next(
            item for item in replayed["figures"][0]["manifest"]["objects"]
            if item.get("id") == obj["id"]
        )
        self.assertEqual(obj.get("fingerprintVersion"), 2, obj)
        self.assertEqual(replayed_obj.get("fingerprintVersion"), 2, replayed_obj)
        self.assertEqual(replayed_obj.get("stableKey"), obj.get("stableKey"))
        self.assertEqual(replayed_obj.get("fingerprint"), obj.get("fingerprint"))
        self.assertEqual(
            replayed_obj.get("identity", {}).get("seriesKey"),
            obj.get("identity", {}).get("seriesKey"),
        )
        actual_value = replayed_obj.get("currentProps", {}).get(prop)
        if prop == "color" or prop.endswith("color"):
            from matplotlib import colors as mcolors
            if isinstance(actual_value, list) and actual_value and isinstance(actual_value[0], list):
                actual_value = actual_value[0]
            self.assertEqual(mcolors.to_hex(actual_value), mcolors.to_hex(value), replayed_obj)
        elif isinstance(value, float):
            self.assertAlmostEqual(actual_value, value, msg=replayed_obj)
        else:
            self.assertEqual(actual_value, value, replayed_obj)

    def test_by_kind_reports_capability_union_intersection_and_variants(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.set_title("Title")
ax.set_xlabel("X")
ax.plot([0, 1, 2], [1, 2, 3], color="#4477aa", label="line A")
ax.plot([0, 1, 2], [3, 2, 1], color="#cc6677", marker="o", label="line B")
ax.legend()
"""
        )
        report = self._coverage_report(manifest)
        objects_by_kind = {}
        for obj in manifest.get("objects", []):
            objects_by_kind.setdefault(obj.get("kind"), []).append(obj)

        for kind, objects in objects_by_kind.items():
            prop_sets = [set(obj.get("editable") or []) for obj in objects]
            union = sorted(set().union(*prop_sets)) if prop_sets else []
            intersection = sorted(set.intersection(*prop_sets)) if prop_sets else []
            variants = {}
            for props in prop_sets:
                key = tuple(sorted(props))
                variants[key] = variants.get(key, 0) + 1
            detail = report["byKind"].get(kind)
            self.assertIsNotNone(detail, (kind, report))
            self.assertEqual(detail.get("editableProps"), union, (kind, detail))
            self.assertEqual(detail.get("editablePropsIntersection"), intersection, (kind, detail))
            actual_variants = {
                tuple(item.get("editableProps") or []): item.get("count")
                for item in detail.get("editablePropVariants", [])
            }
            self.assertEqual(actual_variants, variants, (kind, detail))

    def test_fill_between_has_dedicated_semantics_and_identity_safe_replay(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
x = np.linspace(0, 1, 5)
ax.fill_between(x, x, x + 0.2, color="#4477aa", alpha=0.45, label="band")
ax.scatter(x, x + 0.1, color="#cc6677", label="points")
ax.plot(x, x, color="#222222", label="line")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        bands = [
            obj for obj in manifest.get("objects", [])
            if obj.get("kind") == "fill_between"
        ]
        self.assertEqual(len(bands), 1, manifest.get("coverageReport"))
        band = bands[0]
        self.assertEqual(band.get("role"), "fill_between_series", band)
        self.assertEqual(band.get("semanticCoverage", {}).get("status"), "dedicated", band)
        self.assertEqual(band.get("semanticCoverage", {}).get("family"), "fill_between", band)
        self.assertEqual(
            band.get("editable"),
            ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
            band,
        )
        self.assertTrue(band.get("id", "").startswith("collection.0."), band)
        self.assertTrue(band.get("stableKey", "").startswith("ax0.collection."), band)
        scatter = next(
            obj for obj in manifest.get("objects", [])
            if obj.get("kind") == "collection" and obj.get("role") == "scatter_series"
        )
        self.assertNotEqual(scatter["id"], band["id"])

        edit = {
            "gid": band["id"],
            "prop": "alpha",
            "value": 0.2,
            "mode": "local_patch",
            "stableKey": band.get("stableKey"),
            "fingerprint": band.get("fingerprint"),
            "fingerprintVersion": 2,
            "identity": band.get("identity"),
        }
        replayed = replay_render(script, edit_logs={"fig_1": [edit]})
        self.assertEqual(replayed.get("status"), "success", replayed)
        self.assertEqual(replayed.get("warnings", []), [], replayed)
        replayed_band = next(
            obj for obj in replayed["figures"][0]["manifest"]["objects"]
            if obj.get("id") == band["id"]
        )
        self.assertAlmostEqual(replayed_band["currentProps"]["alpha"], 0.2)

        legacy_replayed = replay_render(script, edit_logs={"fig_1": [{
            "gid": band["id"],
            "prop": "alpha",
            "value": 0.3,
            "mode": "local_patch",
        }]})
        self.assertEqual(legacy_replayed.get("warnings", []), [], legacy_replayed)
        legacy_band = next(
            obj for obj in legacy_replayed["figures"][0]["manifest"]["objects"]
            if obj.get("id") == band["id"]
        )
        self.assertAlmostEqual(legacy_band["currentProps"]["alpha"], 0.3)
        self._assert_classes_not_reported(manifest, {"Line2D"})

    def test_pyplot_fill_between_uses_the_same_dedicated_semantics(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import numpy as np
x = np.linspace(0, 1, 5)
plt.figure()
plt.fill_between(x, x, x + 0.2, color="#4477aa", label="pyplot band")
"""
        )
        bands = [obj for obj in manifest.get("objects", []) if obj.get("kind") == "fill_between"]
        self.assertEqual(len(bands), 1, manifest.get("coverageReport"))
        self.assertEqual(bands[0].get("role"), "fill_between_series", bands[0])
        self.assertEqual(bands[0].get("source", {}).get("callName"), "Axes.fill_between", bands[0])

    def test_fill_between_keeps_static_palette_binding_after_kind_promotion(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import numpy as np
BAND_COLOR = "#4477aa"
x = np.linspace(0, 1, 5)
fig, ax = plt.subplots()
ax.fill_between(x, x, x + 0.2, color=BAND_COLOR, label="band")
"""
        )
        band = next(obj for obj in manifest.get("objects", []) if obj.get("kind") == "fill_between")
        bindings = [
            binding for binding in manifest.get("bindings", [])
            if binding.get("paletteId") == "BAND_COLOR"
        ]
        self.assertEqual(len(bindings), 1, manifest)
        self.assertIn(band["id"], bindings[0].get("gids", []), bindings[0])
        self.assertIn("facecolor", bindings[0].get("props", []), bindings[0])

    def test_contourf_has_dedicated_parent_children_and_colorbar_relation(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
x = np.linspace(-1, 1, 5)
y = np.linspace(-1, 1, 6)
X, Y = np.meshgrid(x, y)
Z = X**2 + Y**2
cs = ax.contourf(X, Y, Z, levels=4, cmap="viridis")
fig.colorbar(cs, ax=ax, label="level")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        objects = self._objects_by_id(manifest)

        contour_sets = [
            obj for obj in manifest.get("objects", [])
            if obj.get("kind") == "contourf"
        ]
        self.assertEqual(len(contour_sets), 1, manifest.get("coverageReport"))
        contour_set = contour_sets[0]
        self.assertTrue(contour_set["id"].startswith("container.contourf.0."), contour_set)
        self.assertEqual(contour_set.get("role"), "contourf_series", contour_set)
        self.assertEqual(
            contour_set.get("editable"),
            ["cmap", "vmin", "vmax", "alpha", "visible", "zorder"],
            contour_set,
        )
        rendered_levels = contour_set.get("currentProps", {}).get("levels")
        self.assertGreaterEqual(len(rendered_levels), 5, contour_set)
        self.assertAlmostEqual(rendered_levels[0], 0.0)
        self.assertAlmostEqual(rendered_levels[-1], 2.0)
        for scientific_prop in ("levels", "X", "Y", "Z"):
            self.assertNotIn(scientific_prop, contour_set.get("editable", []), contour_set)
            self.assertNotIn(
                scientific_prop,
                [item.get("prop") for item in contour_set.get("propertyCapabilities", [])],
                contour_set,
            )
        self.assertTrue(contour_set.get("children"), contour_set)
        for child_gid in contour_set["children"]:
            child = objects[child_gid]
            self.assertEqual(child.get("kind"), "collection", child)
            self.assertEqual(child.get("parentId"), contour_set["id"], child)
            self.assertEqual(child.get("role"), "contour_child_collection", child)
            self.assertEqual(child.get("editable"), [], child)
            self.assertEqual(child.get("propertyCapabilities"), [], child)

        colorbars = [obj for obj in manifest.get("objects", []) if obj.get("kind") == "colorbar"]
        self.assertEqual(
            len(colorbars),
            1,
            f"contourf fixture should expose the colorbar separately; coverage={manifest.get('coverageReport')}",
        )
        self.assertEqual(colorbars[0].get("role"), "colorbar", colorbars[0])
        colorbar_relation = colorbars[0].get("identity", {}).get("relation", {})
        self.assertEqual(colorbar_relation.get("mappableId"), contour_set["id"], colorbars[0])
        contour_relation = contour_set.get("identity", {}).get("relation", {})
        self.assertEqual(contour_relation.get("colorbarId"), colorbars[0]["id"], contour_set)

        rows = self._complex_rows(manifest, {"ContourSet", "QuadContourSet"})
        self.assertEqual(len(rows), 1, rows)
        for row in rows:
            self.assertEqual(row.get("status"), "dedicated", row)
            self.assertEqual(row.get("family"), "contourf", row)

        edits = [
            {
                "gid": contour_set["id"],
                "prop": prop,
                "value": value,
                "mode": "backend_patch",
                "stableKey": contour_set.get("stableKey"),
                "fingerprint": contour_set.get("fingerprint"),
                "fingerprintVersion": 2,
                "identity": contour_set.get("identity"),
            }
            for prop, value in (
                ("cmap", "plasma"),
                ("vmin", 0.25),
                ("vmax", 1.75),
                ("alpha", 0.6),
            )
        ]
        replayed = replay_render(script, edit_logs={"fig_1": edits})
        self.assertEqual(replayed.get("status"), "success", replayed)
        self.assertEqual(replayed.get("warnings", []), [], replayed)
        replayed_manifest = replayed["figures"][0]["manifest"]
        replayed_contour = next(
            obj for obj in replayed_manifest["objects"]
            if obj.get("id") == contour_set["id"]
        )
        replayed_colorbar = next(
            obj for obj in replayed_manifest["objects"]
            if obj.get("id") == colorbars[0]["id"]
        )
        self.assertEqual(replayed_contour["currentProps"]["cmap"], "plasma")
        self.assertAlmostEqual(replayed_contour["currentProps"]["vmin"], 0.25)
        self.assertAlmostEqual(replayed_contour["currentProps"]["vmax"], 1.75)
        self.assertAlmostEqual(replayed_contour["currentProps"]["alpha"], 0.6)
        self.assertIn("fill-opacity: 0.6", replayed["figures"][0]["svg"])
        self.assertEqual(replayed_colorbar["currentProps"]["cmap"], "plasma")
        self.assertAlmostEqual(replayed_colorbar["currentProps"]["vmin"], 0.25)
        self.assertAlmostEqual(replayed_colorbar["currentProps"]["vmax"], 1.75)
        self.assertEqual(replayed_contour.get("stableKey"), contour_set.get("stableKey"))
        self.assertEqual(replayed_contour.get("fingerprint"), contour_set.get("fingerprint"))
        self.assertEqual(
            replayed_contour.get("identity", {}).get("seriesKey"),
            contour_set.get("identity", {}).get("seriesKey"),
        )
        replayed_objects = self._objects_by_id(replayed_manifest)
        self.assertNotEqual(
            replayed_objects[contour_set["children"][0]]["currentProps"].get("facecolor"),
            objects[contour_set["children"][0]]["currentProps"].get("facecolor"),
        )

        legacy_child_gid = contour_set["children"][0]
        legacy_replayed = replay_render(script, edit_logs={"fig_1": [{
            "gid": legacy_child_gid,
            "prop": "alpha",
            "value": 0.35,
            "mode": "local_patch",
        }]})
        self.assertEqual(legacy_replayed.get("status"), "success", legacy_replayed)
        self.assertEqual(legacy_replayed.get("warnings", []), [], legacy_replayed)
        legacy_child = next(
            obj for obj in legacy_replayed["figures"][0]["manifest"]["objects"]
            if obj.get("id") == legacy_child_gid
        )
        self.assertAlmostEqual(legacy_child["currentProps"]["alpha"], 0.35)

        identity_child = objects[legacy_child_gid]
        current_artist_class = identity_child["source"]["artistClass"]
        other_artist_class = (
            "QuadContourSet"
            if current_artist_class == "PathCollection"
            else "PathCollection"
        )
        cross_version_fingerprint = hashlib.sha256(
            f"{identity_child['stableKey']}|{other_artist_class}".encode("utf-8")
        ).hexdigest()
        identity_edit = {
            "gid": legacy_child_gid,
            "prop": "alpha",
            "value": 0.45,
            "mode": "local_patch",
            "stableKey": identity_child["stableKey"],
            "fingerprint": cross_version_fingerprint,
            "fingerprintVersion": 2,
            "identity": {
                "seriesKey": identity_child["identity"]["seriesKey"],
            },
        }
        cross_version_replayed = replay_render(
            script,
            edit_logs={"fig_1": [identity_edit]},
        )
        self.assertEqual(cross_version_replayed.get("status"), "success", cross_version_replayed)
        self.assertEqual(cross_version_replayed.get("warnings", []), [], cross_version_replayed)
        cross_version_child = next(
            obj for obj in cross_version_replayed["figures"][0]["manifest"]["objects"]
            if obj.get("id") == legacy_child_gid
        )
        self.assertAlmostEqual(cross_version_child["currentProps"]["alpha"], 0.45)

        wrong_series_edit = {
            **identity_edit,
            "identity": {"seriesKey": f"{identity_child['identity']['seriesKey']}.wrong"},
        }
        rejected = replay_render(script, edit_logs={"fig_1": [wrong_series_edit]})
        self.assertEqual(rejected.get("status"), "success", rejected)
        self.assertEqual(
            [warning.get("type") for warning in rejected.get("warnings", [])],
            ["identity_mismatch"],
            rejected,
        )

    def test_contour_line_parent_replays_line_style_without_editing_levels(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
x = np.linspace(-1, 1, 5)
y = np.linspace(-1, 1, 6)
X, Y = np.meshgrid(x, y)
Z = X**2 + Y**2
ax.contour(X, Y, Z, levels=[0.25, 0.75, 1.25], cmap="viridis", linewidths=1.2)
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        contour = next(obj for obj in manifest["objects"] if obj.get("kind") == "contour")
        self.assertEqual(contour.get("role"), "contour_series", contour)
        self.assertEqual(
            contour.get("editable"),
            ["cmap", "vmin", "vmax", "alpha", "linewidth", "linestyle", "visible", "zorder"],
            contour,
        )
        self.assertEqual(contour.get("currentProps", {}).get("levels"), [0.25, 0.75, 1.25])
        self.assertNotIn("levels", contour.get("editable", []), contour)
        for capability in contour.get("propertyCapabilities", []):
            self.assertEqual(capability.get("patchMode"), "backend_patch", capability)
            self.assertEqual(capability.get("preview"), "none", capability)

        edits = [
            {
                "gid": contour["id"],
                "prop": prop,
                "value": value,
                "mode": "backend_patch",
            }
            for prop, value in (
                ("linewidth", 2.5),
                ("linestyle", "dashed"),
                ("alpha", 0.55),
                ("zorder", 7),
            )
        ]
        replayed = replay_render(script, edit_logs={"fig_1": edits})
        self.assertEqual(replayed.get("status"), "success", replayed)
        self.assertEqual(replayed.get("warnings", []), [], replayed)
        replayed_contour = next(
            obj for obj in replayed["figures"][0]["manifest"]["objects"]
            if obj.get("id") == contour["id"]
        )
        self.assertAlmostEqual(replayed_contour["currentProps"]["linewidth"], 2.5)
        self.assertEqual(replayed_contour["currentProps"]["linestyle"], "dashed")
        self.assertAlmostEqual(replayed_contour["currentProps"]["alpha"], 0.55)
        self.assertAlmostEqual(replayed_contour["currentProps"]["zorder"], 7.0)

    def test_pyplot_contourf_uses_the_same_dedicated_parent(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import numpy as np
x = np.linspace(-1, 1, 5)
X, Y = np.meshgrid(x, x)
plt.figure()
plt.contourf(X, Y, X + Y, levels=4, cmap="viridis")
"""
        )
        contour = next(obj for obj in manifest["objects"] if obj.get("kind") == "contourf")
        self.assertEqual(contour.get("role"), "contourf_series", contour)
        self.assertEqual(contour.get("source", {}).get("callName"), "Axes.contourf", contour)

    def test_pie_wedges_are_reported_as_flattened_editable(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.pie(
    [2, 3, 5],
    labels=["A", "B", "C"],
    colors=["#4477aa", "#cc6677", "#228833"],
    autopct="%1.0f%%",
)
"""
        )

        self._assert_flattened_editable_reported(manifest, "Wedge", "wedge")

    def test_quiver_is_reported_as_flattened_editable(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
x, y = np.meshgrid([0, 1, 2], [0, 1])
u = np.ones_like(x)
v = np.array([[0, 1, 0], [1, 0, -1]])
ax.quiver(x, y, u, v, color="#4477aa")
"""
        )

        self._assert_flattened_editable_reported(manifest, "Quiver", "quiver")

    def test_streamplot_candidates_are_reported_ambiguous_not_dedicated(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
y, x = np.mgrid[-1:1:5j, -1:1:5j]
u = -y
v = x
ax.streamplot(x, y, u, v, color="#4477aa", density=0.6)
"""
        )

        self._assert_ambiguous_classes_not_dedicated(
            manifest,
            {"LineCollection", "FancyArrowPatch"},
        )

    def test_hist_bar_container_has_histogram_identity_and_parent_owned_children(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
HIST_COLOR = "#4477aa"
BAR_COLOR = "#ddaa33"
ax.hist([0, 1, 1, 2, 2, 2], bins=[0, 1, 2, 3], color=HIST_COLOR, alpha=0.5, label="hist")
ax.bar([3.4, 4.4], [1.5, 2.5], color=BAR_COLOR, label="plain bar")
ax.legend()
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        objects = self._objects_by_id(manifest)
        bar_containers = [
            obj for obj in manifest.get("objects", [])
            if obj.get("kind") == "bar_container"
        ]

        histogram = next(
            (obj for obj in bar_containers if obj.get("role") == "histogram_series"),
            None,
        )
        self.assertIsNotNone(histogram, bar_containers)
        self.assertTrue(histogram["id"].startswith("container.bar."), histogram)
        self.assertEqual(
            histogram.get("identity", {}).get("semanticKey"),
            "histogram_series:subplot.0",
            histogram,
        )
        self.assertEqual(
            histogram.get("semanticCoverage", {}).get("status"),
            "dedicated",
            histogram,
        )
        self.assertEqual(
            histogram.get("semanticCoverage", {}).get("family"),
            "hist",
            histogram,
        )
        self.assertTrue(histogram.get("children"), histogram)
        self.assertEqual(histogram.get("label"), "hist", histogram)
        self.assertEqual(histogram.get("stableKey"), "ax0.bar_container.idx.0", histogram)
        for child_gid in histogram["children"]:
            child = objects[child_gid]
            self.assertEqual(child.get("parentId"), histogram["id"], child)
            self.assertEqual(child.get("role"), "histogram_child_patch", child)
            self.assertTrue(
                child.get("currentProps", {}).get("parentOwned")
                or (child.get("editable") == [] and child.get("propertyCapabilities") == []),
                child,
            )

        legend_marker_ids = histogram.get("identity", {}).get("relation", {}).get("legendMarkerIds", [])
        self.assertEqual(len(legend_marker_ids), 1, histogram)
        legend_marker = objects[legend_marker_ids[0]]
        self.assertEqual(legend_marker.get("role"), "legend_marker", legend_marker)
        self.assertEqual(
            legend_marker.get("identity", {}).get("relation", {}).get("parentId"),
            histogram["id"],
            legend_marker,
        )

        bindings = [
            binding for binding in manifest.get("bindings", [])
            if binding.get("paletteId") == "HIST_COLOR"
        ]
        self.assertEqual(len(bindings), 1, manifest.get("bindings"))
        self.assertIn(histogram["id"], bindings[0].get("gids", []), bindings[0])
        self.assertIn(legend_marker["id"], bindings[0].get("gids", []), bindings[0])
        self.assertTrue(
            all(child_gid not in bindings[0].get("gids", []) for child_gid in histogram["children"]),
            bindings[0],
        )

        plain_bar = next(
            obj for obj in bar_containers
            if obj["id"] != histogram["id"] and obj.get("label") == "plain bar"
        )
        self.assertEqual(plain_bar.get("role"), "bar_series", plain_bar)
        self.assertNotEqual(plain_bar.get("role"), "histogram_series", plain_bar)
        self.assertNotEqual(
            plain_bar.get("identity", {}).get("semanticKey"),
            "histogram_series:subplot.0",
            plain_bar,
        )
        ordinary_bar_bindings = [
            binding for binding in manifest.get("bindings", [])
            if binding.get("paletteId") == "BAR_COLOR"
        ]
        self.assertEqual(len(ordinary_bar_bindings), 1, manifest.get("bindings"))
        self.assertNotIn(plain_bar["id"], ordinary_bar_bindings[0].get("gids", []), ordinary_bar_bindings[0])
        self.assertTrue(
            any(child_gid in ordinary_bar_bindings[0].get("gids", []) for child_gid in plain_bar.get("children", [])),
            ordinary_bar_bindings[0],
        )

        self._assert_visual_only_capabilities(
            histogram,
            ["color", "facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
            ["bins", "counts", "values", "edges", "density", "orientation"],
        )
        self._assert_fingerprint_stable_after_style_edit(script, histogram, "alpha", 0.25)

        blocked = replay_render(script, edit_logs={"fig_1": [{
            "gid": histogram["id"],
            "prop": "bins",
            "value": [0, 1, 3],
            "mode": "backend_patch",
        }]})
        self.assertEqual(blocked.get("status"), "success", blocked)
        self.assertEqual(
            [warning.get("type") for warning in blocked.get("warnings", [])],
            ["unsupported_prop"],
            blocked,
        )

        legacy_child = objects[histogram["children"][0]]
        legacy_replayed = replay_render(script, edit_logs={"fig_1": [{
            "gid": legacy_child["id"],
            "prop": "facecolor",
            "value": "#8844aa",
            "mode": "local_patch",
            "stableKey": legacy_child["stableKey"],
            "fingerprint": legacy_child["fingerprint"],
            "identity": {"seriesKey": legacy_child["identity"]["seriesKey"]},
        }]})
        self.assertEqual(legacy_replayed.get("warnings", []), [], legacy_replayed)

    def test_hist_step_variants_keep_patch_identity_with_histogram_role(self):
        script = """
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon
fig, ax = plt.subplots()
ax.hist([0, 1, 1, 2], bins=[0, 1, 2, 3], histtype="step", color="#4477aa", label="outline")
ax.hist([0, 1, 2, 2], bins=[0, 1, 2, 3], histtype="stepfilled", color="#cc6677", label="filled")
ax.add_patch(Polygon([[3.2, 0], [3.6, 0], [3.4, 1]], closed=True, label="manual polygon"))
"""
        manifest = self._render_manifest(script)
        histogram_patches = [
            obj for obj in manifest.get("objects", [])
            if obj.get("kind") == "patch" and obj.get("role") == "histogram_series"
        ]
        self.assertEqual([obj.get("label") for obj in histogram_patches], ["outline", "filled"])
        for obj in histogram_patches:
            self.assertTrue(obj["id"].startswith("patch."), obj)
            self.assertEqual(obj["stableKey"], f"ax0.patch.label.{obj['label']}", obj)
            self.assertEqual(obj.get("source", {}).get("callName"), "Axes.hist", obj)
            self.assertNotIn("bins", obj.get("editable", []), obj)
            self.assertNotIn("counts", self._capability_props(obj), obj)

        manual = next(obj for obj in manifest.get("objects", []) if obj.get("label") == "manual polygon")
        self.assertNotEqual(manual.get("role"), "histogram_series", manual)

    def test_multi_dataset_histogram_keeps_each_series_identity_and_structure(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.hist(
    [[0, 0.5, 1, 1], [0.5, 1.5, 2, 2]],
    bins=[0, 1, 2, 3],
    color=["#4477aa", "#cc6677"],
    label=["Group A", "Group B"],
)
ax.legend()
"""
        )
        objects = self._objects_by_id(manifest)
        histograms = [
            obj for obj in manifest.get("objects", [])
            if obj.get("role") == "histogram_series"
        ]
        self.assertEqual([obj.get("label") for obj in histograms], ["Group A", "Group B"])
        self.assertEqual(
            [obj.get("stableKey") for obj in histograms],
            ["ax0.bar_container.idx.0", "ax0.bar_container.idx.1"],
        )
        self.assertNotEqual(
            histograms[0].get("currentProps", {}).get("counts"),
            histograms[1].get("currentProps", {}).get("counts"),
        )
        for histogram in histograms:
            self.assertTrue(histogram.get("children"), histogram)
            self.assertEqual(
                len(histogram.get("identity", {}).get("relation", {}).get("legendMarkerIds", [])),
                1,
                histogram,
            )
            for child_gid in histogram["children"]:
                self.assertTrue(objects[child_gid].get("currentProps", {}).get("parentOwned"), objects[child_gid])

    def test_stairs_steppatch_has_dedicated_readonly_structure(self):
        script = """
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, StepPatch
fig, ax = plt.subplots()
ax.stairs([1, 2, 1], [0, 1, 2, 3], color="#cc6677", label="stairs")
ax.add_patch(Rectangle((3.2, 0.2), 0.4, 0.5, facecolor="#999999", label="plain patch"))
ax.add_patch(StepPatch([1, 1.5, 1], [4, 5, 6, 7], label="manual stairs"))
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        patch_like = [
            obj for obj in manifest.get("objects", [])
            if obj.get("id", "").startswith("patch.")
        ]

        stairs = next(
            (obj for obj in patch_like if obj.get("role") == "stairs_series"),
            None,
        )
        self.assertIsNotNone(stairs, patch_like)
        self.assertTrue(stairs["id"].startswith("patch."), stairs)
        self.assertEqual(stairs.get("kind"), "patch", stairs)
        self.assertEqual(
            stairs.get("identity", {}).get("semanticKey"),
            "stairs_series:subplot.0",
            stairs,
        )
        self.assertEqual(stairs.get("currentProps", {}).get("values"), [1, 2, 1], stairs)
        self.assertEqual(stairs.get("currentProps", {}).get("edges"), [0, 1, 2, 3], stairs)
        self.assertEqual(stairs.get("currentProps", {}).get("baseline"), 0, stairs)
        self.assertEqual(
            stairs.get("semanticCoverage", {}).get("status"),
            "dedicated",
            stairs,
        )
        self.assertEqual(
            stairs.get("semanticCoverage", {}).get("family"),
            "stairs",
            stairs,
        )

        plain_patch = next(obj for obj in patch_like if obj.get("label") == "plain patch")
        self.assertNotEqual(plain_patch.get("kind"), "stairs", plain_patch)
        self.assertNotEqual(plain_patch.get("role"), "stairs_series", plain_patch)
        manual_stairs = next(obj for obj in patch_like if obj.get("label") == "manual stairs")
        self.assertNotEqual(manual_stairs.get("role"), "stairs_series", manual_stairs)

        self._assert_visual_only_capabilities(
            stairs,
            ["facecolor", "edgecolor", "alpha", "linewidth", "zorder"],
            ["values", "edges", "baseline"],
        )
        self._assert_fingerprint_stable_after_style_edit(script, stairs, "edgecolor", "#114488")

        blocked = replay_render(script, edit_logs={"fig_1": [{
            "gid": stairs["id"], "prop": "edges", "value": [0, 2, 3, 4], "mode": "backend_patch",
        }]})
        self.assertEqual([item.get("type") for item in blocked.get("warnings", [])], ["unsupported_prop"], blocked)

    def test_step_line_has_dedicated_readonly_structure_without_plot_bleed(self):
        script = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.step([0, 1, 2], [2, 1, 3], where="mid", color="#228833", label="step")
ax.plot([0, 1, 2], [3, 3.5, 3.2], drawstyle="steps-mid", color="#222222", label="plain line")
"""
        initial = replay_render(script)
        self.assertEqual(initial.get("status"), "success", initial)
        manifest = initial["figures"][0]["manifest"]
        lines = [obj for obj in manifest.get("objects", []) if obj.get("kind") == "line"]

        step_line = next(
            (obj for obj in lines if obj.get("role") == "step_series"),
            None,
        )
        self.assertIsNotNone(step_line, lines)
        self.assertTrue(step_line["id"].startswith("line."), step_line)
        self.assertEqual(
            step_line.get("identity", {}).get("semanticKey"),
            "step_series:subplot.0",
            step_line,
        )
        self.assertEqual(step_line.get("currentProps", {}).get("where"), "mid", step_line)
        self.assertEqual(
            step_line.get("semanticCoverage", {}).get("status"),
            "dedicated",
            step_line,
        )
        self.assertEqual(
            step_line.get("semanticCoverage", {}).get("family"),
            "step",
            step_line,
        )

        plain_line = next(obj for obj in lines if obj.get("label") == "plain line")
        self.assertEqual(plain_line.get("role"), "line_series", plain_line)
        self.assertNotEqual(plain_line.get("role"), "step_series", plain_line)

        self._assert_visual_only_capabilities(
            step_line,
            ["color", "linewidth", "linestyle", "alpha", "marker", "markersize", "zorder"],
            ["x", "y", "xdata", "ydata", "where", "drawstyle"],
        )
        self._assert_fingerprint_stable_after_style_edit(script, step_line, "color", "#1166aa")

        blocked = replay_render(script, edit_logs={"fig_1": [{
            "gid": step_line["id"], "prop": "where", "value": "post", "mode": "backend_patch",
        }]})
        self.assertEqual([item.get("type") for item in blocked.get("warnings", [])], ["unsupported_prop"], blocked)

    def test_pyplot_hist_stairs_and_step_use_trusted_axes_call_provenance(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
plt.figure()
plt.hist([0, 1, 1, 2], bins=[0, 1, 2, 3], label="hist")
plt.stairs([1, 2, 1], [0, 1, 2, 3], label="stairs")
plt.step([0, 1, 2], [2, 1, 3], label="step")
"""
        )
        by_role = {obj.get("role"): obj for obj in manifest.get("objects", [])}
        for role, call_name in {
            "histogram_series": "Axes.hist",
            "stairs_series": "Axes.stairs",
            "step_series": "Axes.step",
        }.items():
            self.assertEqual(by_role[role].get("source", {}).get("callName"), call_name, by_role[role])

    def test_plain_plot_scatter_bar_do_not_report_complex_coverage(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3], color="#4477aa")
ax.scatter([0, 1, 2], [3, 2, 1], color="#cc6677")
ax.bar([0, 1, 2], [2, 3, 1], color="#228833")
"""
        )

        self._assert_no_complex_coverage(manifest)


if __name__ == "__main__":
    unittest.main()

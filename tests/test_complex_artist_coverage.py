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

    def test_contourf_with_colorbar_keeps_colorbar_and_reports_complex_rows(self):
        manifest = self._render_manifest(
            """
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
        )

        colorbars = [obj for obj in manifest.get("objects", []) if obj.get("kind") == "colorbar"]
        self.assertEqual(
            len(colorbars),
            1,
            f"contourf fixture should expose the colorbar separately; coverage={manifest.get('coverageReport')}",
        )
        self.assertEqual(colorbars[0].get("role"), "colorbar", colorbars[0])

        rows = self._complex_rows(manifest, {"ContourSet", "QuadContourSet"})
        for row in rows:
            self.assertEqual(row.get("status"), "flattened", row)
            self.assertIn(row.get("family"), {"contour", "contourf", "contour_family"}, row)
        self._assert_classes_not_reported(manifest, {"PathCollection", "PolyCollection"})

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

    def test_hist_stairs_step_shadow_coverage_is_conservative(self):
        manifest = self._render_manifest(
            """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.hist([0, 1, 1, 2, 2, 2], bins=[0, 1, 2, 3], color="#4477aa", alpha=0.5, label="hist")
ax.stairs([1, 2, 1], [0, 1, 2, 3], color="#cc6677", label="stairs")
ax.step([0, 1, 2], [2, 1, 3], where="mid", color="#228833", label="step")
"""
        )

        self._assert_flattened_editable_reported(manifest, "StepPatch", "stairs")
        self._assert_classes_not_reported(manifest, {"BarContainer", "Rectangle", "Line2D"})

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

import base64
import json
import pathlib
import re
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_r_renderer import _backend_patch, _object, _objects, _run_r_renderer  # noqa: E402


RADAR_FIXTURE = ROOT / "tests" / "fixtures" / "capability_matrix" / "r" / "radar_chart.R"


def _script() -> str:
    return RADAR_FIXTURE.read_text(encoding="utf-8")


def _radar_objects(result):
    return [
        obj for obj in _objects(result)
        if obj.get("currentProps", {}).get("radarId")
    ]


def _legacy_radar_fill_patch(obj, prop, value):
    """Build the persisted identity evidence emitted before radar fills became patches."""
    old_stable_key = obj["stableKey"].replace("r:patch:", "r:line:", 1)
    if old_stable_key == obj["stableKey"]:
        raise AssertionError(f"Expected a radar patch stable key, got {obj['stableKey']!r}")

    fingerprint_payload = json.loads(
        base64.b64decode(obj["fingerprint"][len("r-v2:"):]).decode("utf-8")
    )
    fingerprint_payload["kind"] = "line"
    fingerprint_payload["stableKey"] = old_stable_key
    for key in ("radarId", "radarSemanticRole", "radarSeriesId", "radarDimensionIndex"):
        fingerprint_payload.get("relation", {}).pop(key, None)

    identity = json.loads(json.dumps(obj["identity"], ensure_ascii=False))
    for key in ("radarId", "radarSemanticRole", "radarSeriesId", "radarDimensionIndex"):
        identity.get("relation", {}).pop(key, None)

    fingerprint = "r-v2:" + base64.b64encode(
        json.dumps(fingerprint_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return {
        "gid": obj["id"],
        "prop": prop,
        "value": value,
        "mode": "backend_patch",
        "stableKey": old_stable_key,
        "fingerprint": fingerprint,
        "fingerprintVersion": obj["fingerprintVersion"],
        "identity": identity,
    }


def _legacy_unversioned_radar_fill_patch(obj, prop, value):
    """Build the same legacy line identity before fingerprint v2 existed."""
    patch = _legacy_radar_fill_patch(obj, prop, value)
    patch.pop("fingerprint")
    patch.pop("fingerprintVersion")
    return patch


@unittest.skipUnless(RADAR_FIXTURE.exists(), "R radar fixture is unavailable")
class TestRRadarChartSpecialization(unittest.TestCase):
    def test_trusted_radar_exposes_individual_series_fill_legend_and_dimension_label_semantics(self):
        result = _run_r_renderer(_script())
        objects = _objects(result)

        polygon = _object(result, "r.layer.0")
        line_layer = _object(result, "r.layer.1")
        self.assertEqual(polygon["kind"], "patch")
        self.assertNotEqual(polygon["kind"], "unsupported")
        self.assertEqual(polygon["currentProps"]["radarSemanticRole"], "fill_layer")
        self.assertEqual(line_layer["currentProps"]["radarSemanticRole"], "series_layer")
        self.assertEqual(line_layer["editable"], [])

        color_groups = [
            obj for obj in objects
            if obj["id"].startswith("r.group.color.")
        ]
        fill_groups = [
            obj for obj in objects
            if obj["id"].startswith("r.group.fill.")
        ]
        self.assertEqual(len(color_groups), 2)
        self.assertEqual(len(fill_groups), 2)
        self.assertTrue(all(obj["kind"] == "line" for obj in color_groups))
        self.assertTrue(all(obj["kind"] == "patch" for obj in fill_groups))
        self.assertTrue(all(obj["currentProps"].get("radarSemanticRole") == "series" for obj in color_groups))
        self.assertTrue(all(obj["currentProps"].get("radarSemanticRole") == "fill" for obj in fill_groups))

        radar_id = color_groups[0]["currentProps"]["radarId"]
        self.assertTrue(all(obj["currentProps"].get("radarId") == radar_id for obj in color_groups + fill_groups))
        by_key = {obj["currentProps"]["groupKey"]: obj for obj in color_groups}
        fill_by_key = {obj["currentProps"]["groupKey"]: obj for obj in fill_groups}
        self.assertEqual(set(by_key), {"Control", "Treatment"})
        self.assertEqual(set(fill_by_key), set(by_key))
        for key in by_key:
            self.assertEqual(
                by_key[key]["currentProps"]["radarSeriesId"],
                fill_by_key[key]["currentProps"]["radarSeriesId"],
            )

        labels = [
            obj for obj in objects
            if obj["id"].startswith("xtick.")
            and obj["currentProps"].get("radarSemanticRole") == "dimension_label"
        ]
        self.assertEqual(len(labels), 5)
        self.assertTrue(all(obj["kind"] == "xtick" for obj in labels))
        self.assertTrue(all("radar_label_offset" in obj["editable"] for obj in labels))

        legend_text = [obj for obj in objects if obj.get("role") == "legend_text"]
        self.assertEqual(len(legend_text), 2)
        self.assertTrue(all(obj["currentProps"].get("radarSemanticRole") == "legend_text" for obj in legend_text))
        self.assertEqual(
            {obj["currentProps"].get("radarSeriesId") for obj in legend_text},
            {obj["currentProps"].get("radarSeriesId") for obj in color_groups},
        )

        identity_relations = [obj.get("identity", {}).get("relation", {}) for obj in _radar_objects(result)]
        self.assertTrue(all(relation.get("radarId") == radar_id for relation in identity_relations))

    def test_radar_scale_patch_isolated_to_selected_series_and_replays_dimension_offset(self):
        baseline = _run_r_renderer(_script())
        color_control = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "series"
            and obj["currentProps"].get("groupKey") == "Control"
        )
        fill_treatment = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )
        label = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "dimension_label"
            and obj["currentProps"].get("text") == "Quality"
        )

        replayed = _run_r_renderer(_script(), [
            _backend_patch(color_control, "color", "#123456"),
            _backend_patch(fill_treatment, "facecolor", "#ABCDEF"),
            _backend_patch(label, "radar_label_offset", {"dx": 11.0, "dy": 7.0}),
        ])
        self.assertFalse(replayed["conflict"], replayed)

        control_replayed = _object(replayed, color_control["id"])
        treatment_fill_replayed = _object(replayed, fill_treatment["id"])
        other_color = next(
            obj for obj in _objects(replayed)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "series"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )
        other_fill = next(
            obj for obj in _objects(replayed)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Control"
        )
        self.assertEqual(control_replayed["currentProps"]["color"].lower(), "#123456")
        self.assertEqual(treatment_fill_replayed["currentProps"]["facecolor"].lower(), "#abcdef")
        self.assertNotEqual(other_color["currentProps"]["color"].lower(), "#123456")
        self.assertNotEqual(other_fill["currentProps"]["facecolor"].lower(), "#abcdef")

        label_replayed = _object(replayed, label["id"])
        self.assertEqual(label_replayed["currentProps"]["radar_label_offset"], {"dx": 11, "dy": 7})
        svg = replayed["svg"]
        pattern = re.compile(r'<text[^>]*(?:id|data-fig-id)="' + re.escape(label["id"]) + r'"[^>]*>', re.I)
        tag = pattern.search(svg)
        self.assertIsNotNone(tag, "radar label SVG id is absent")
        self.assertIn("translate(11 -7)", tag.group(0))

    def test_generic_coord_polar_does_not_acquire_radar_semantics(self):
        script = """
library(ggplot2)
df <- data.frame(category = c('A', 'B', 'C', 'D'), value = c(4, 2, 5, 3))
ggplot(df, aes(category, value, fill = category)) + geom_col() + coord_polar()
"""
        result = _run_r_renderer(script)
        self.assertFalse(any(obj.get("currentProps", {}).get("radarId") for obj in _objects(result)))

    def test_legacy_line_fill_evidence_replays_only_its_radar_series(self):
        baseline = _run_r_renderer(_script())
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )
        legacy_patch = _legacy_radar_fill_patch(target, "facecolor", "#12AB34")

        replayed = _run_r_renderer(_script(), [legacy_patch])

        self.assertFalse(replayed["conflict"], replayed)
        self.assertEqual(replayed["skipped"], [])
        self.assertEqual(
            _object(replayed, target["id"])["currentProps"]["facecolor"].lower(),
            "#12ab34",
        )
        unaffected = next(
            obj for obj in _objects(replayed)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Control"
        )
        self.assertNotEqual(unaffected["currentProps"]["facecolor"].lower(), "#12ab34")

    def test_unversioned_legacy_line_fill_evidence_replays_only_its_radar_series(self):
        baseline = _run_r_renderer(_script())
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )
        legacy_patch = _legacy_unversioned_radar_fill_patch(
            target,
            "facecolor",
            "#24A148",
        )

        self.assertNotIn("fingerprint", legacy_patch)
        self.assertNotIn("fingerprintVersion", legacy_patch)
        replayed = _run_r_renderer(_script(), [legacy_patch])

        self.assertFalse(replayed["conflict"], replayed)
        self.assertEqual(replayed["skipped"], [])
        self.assertEqual(
            _object(replayed, target["id"])["currentProps"]["facecolor"].lower(),
            "#24a148",
        )
        unaffected = next(
            obj for obj in _objects(replayed)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Control"
        )
        self.assertNotEqual(unaffected["currentProps"]["facecolor"].lower(), "#24a148")

    def test_unversioned_legacy_radar_fill_requires_complete_unforged_relation(self):
        baseline = _run_r_renderer(_script())
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )

        missing_scale = _legacy_unversioned_radar_fill_patch(target, "facecolor", "#24A148")
        missing_scale["identity"]["relation"].pop("scaleKey")

        forged_radar_role = _legacy_unversioned_radar_fill_patch(target, "facecolor", "#24A148")
        forged_radar_role["identity"]["relation"]["radarSemanticRole"] = "series"

        wrong_aesthetic = _legacy_unversioned_radar_fill_patch(target, "facecolor", "#24A148")
        wrong_aesthetic["identity"]["relation"]["aesthetic"] = "color"

        wrong_scale = _legacy_unversioned_radar_fill_patch(target, "facecolor", "#24A148")
        wrong_scale["identity"]["relation"]["scaleKey"] += ":forged"

        incomplete_v2 = _legacy_unversioned_radar_fill_patch(target, "facecolor", "#24A148")
        incomplete_v2["fingerprintVersion"] = 2

        for label, forged in (
            ("missing scale relation", missing_scale),
            ("forged radar role", forged_radar_role),
            ("wrong aesthetic", wrong_aesthetic),
            ("wrong scale", wrong_scale),
            ("incomplete v2", incomplete_v2),
        ):
            with self.subTest(label=label):
                replayed = _run_r_renderer(_script(), [forged])
                self.assertTrue(replayed["conflict"], replayed)
                self.assertEqual(replayed["applied"], [])
                self.assertEqual(replayed["skipped"], [forged])
                self.assertNotEqual(
                    _object(replayed, target["id"])["currentProps"]["facecolor"].lower(),
                    "#24a148",
                )

    def test_legacy_radar_fill_evidence_rejects_stable_key_or_series_identity_drift(self):
        baseline = _run_r_renderer(_script())
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Treatment"
        )
        control = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("radarSemanticRole") == "fill"
            and obj["currentProps"].get("groupKey") == "Control"
        )

        stable_key_drift = _legacy_radar_fill_patch(target, "facecolor", "#12AB34")
        stable_key_drift["stableKey"] += ":forged"
        stable_payload = json.loads(
            base64.b64decode(stable_key_drift["fingerprint"][len("r-v2:"):]).decode("utf-8")
        )
        stable_payload["stableKey"] = stable_key_drift["stableKey"]
        stable_key_drift["fingerprint"] = "r-v2:" + base64.b64encode(
            json.dumps(stable_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")

        series_drift = _legacy_radar_fill_patch(target, "facecolor", "#12AB34")
        series_drift["identity"]["semanticKey"] = control["identity"]["semanticKey"]
        series_drift["identity"]["seriesKey"] = control["identity"]["seriesKey"]
        series_drift["identity"]["relation"]["groupKey"] = "Control"
        series_payload = json.loads(
            base64.b64decode(series_drift["fingerprint"][len("r-v2:"):]).decode("utf-8")
        )
        series_payload["semanticKey"] = control["identity"]["semanticKey"]
        series_payload["seriesKey"] = control["identity"]["seriesKey"]
        series_payload["relation"]["groupKey"] = "Control"
        series_drift["fingerprint"] = "r-v2:" + base64.b64encode(
            json.dumps(series_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")

        for label, forged in (("stable key", stable_key_drift), ("series identity", series_drift)):
            with self.subTest(label=label):
                replayed = _run_r_renderer(_script(), [forged])
                self.assertTrue(replayed["conflict"], replayed)
                self.assertEqual(replayed["applied"], [])
                self.assertEqual(replayed["skipped"], [forged])
                self.assertNotEqual(
                    _object(replayed, target["id"])["currentProps"]["facecolor"].lower(),
                    "#12ab34",
                )


if __name__ == "__main__":
    unittest.main()

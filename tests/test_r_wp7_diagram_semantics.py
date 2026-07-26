import re
import sys
import unittest
import copy
from pathlib import Path


TESTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_ROOT))

from test_capability_matrix import read_synthetic_fixture, run_r_fixture, rscript_bin  # noqa: E402
from test_r_renderer import _backend_patch, _run_r_renderer  # noqa: E402


FIXTURE_RELATIVE_PATH = "r/network_path_sem.R"
DIAGRAM_ID = "sem.demo"
EDGE_ID = "latent_a_to_observed_b"
PATH_EDGE_ID = "latent_a_path_to_observed_b"
EXPECTED_OBJECTS = {
    "latent": ("diagram_node", "latent_a"),
    "observed": ("diagram_node", "observed_b"),
    "edge": ("diagram_edge", EDGE_ID),
    "path_edge": ("diagram_edge", PATH_EDGE_ID),
    "arrow": ("diagram_arrow", "arrow_a_b"),
    "latent_label": ("diagram_node_label", "label_latent_a"),
    "observed_label": ("diagram_node_label", "label_observed_b"),
    "coefficient": ("diagram_coefficient_label", "coef_a_b"),
    "fit": ("diagram_fit_annotation", "fit_summary"),
    "group": ("diagram_group", "measurement_model"),
}


def capability_props(obj):
    return {item.get("prop") for item in obj.get("propertyCapabilities", [])}


def object_by_role_and_object_id(objects, role, diagram_object_id):
    return next(
        (
            obj for obj in objects
            if obj.get("role") == role
            and obj.get("identity", {}).get("relation", {}).get("diagramObjectId") == diagram_object_id
        ),
        None,
    )


@unittest.skipUnless(rscript_bin() and Path(rscript_bin()).exists(), "Rscript is not available")
class TestRWP7DiagramSemantics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = read_synthetic_fixture(FIXTURE_RELATIVE_PATH)
        cls.result = run_r_fixture(cls.source)
        cls.manifest = cls.result.get("manifest", {})
        cls.objects = cls.manifest.get("objects", [])

    def test_fixture_declares_all_explicit_semantic_markers(self):
        self.assertNotRegex(self.source, r"\bread_csv\s*\(|\bread\.csv\s*\(|uploaded_file_paths")
        for raw_role in (
            "node",
            "edge",
            "arrow",
            "node_label",
            "coefficient_label",
            "fit_annotation",
            "group",
        ):
            self.assertIn(f'"{raw_role}"', self.source)
        for token in (
            "latent_a",
            "observed_b",
            EDGE_ID,
            "arrow_a_b",
            "label_latent_a",
            "label_observed_b",
            "coef_a_b",
            "fit_summary",
            "measurement_model",
            "beta = 0.42, p = 0.003",
            "CFI = 0.96; RMSEA = 0.04",
        ):
            self.assertIn(token, self.source)

    def test_manifest_exposes_explicit_r_diagram_roles_and_relations(self):
        found = {}
        for label, (role, diagram_object_id) in EXPECTED_OBJECTS.items():
            obj = object_by_role_and_object_id(self.objects, role, diagram_object_id)
            self.assertIsNotNone(
                obj,
                f"missing {label} {role}/{diagram_object_id}; "
                f"roles={[(item.get('id'), item.get('role'), item.get('identity', {}).get('relation')) for item in self.objects]}",
            )
            found[label] = obj
            relation = obj.get("identity", {}).get("relation", {})
            self.assertEqual(relation.get("diagramId"), DIAGRAM_ID, obj)
            self.assertEqual(relation.get("diagramType"), "sem", obj)
            self.assertEqual(obj.get("source", {}).get("callName"), "SciFigure.semantic_gid", obj)
            self.assertEqual(obj.get("semanticCoverage", {}).get("family"), "diagram", obj)
            self.assertEqual(obj.get("semanticCoverage", {}).get("status"), "dedicated", obj)

        self.assertEqual(found["latent"]["identity"]["relation"].get("nodeId"), "latent_a")
        self.assertEqual(found["observed"]["identity"]["relation"].get("nodeId"), "observed_b")
        self.assertEqual(found["edge"]["identity"]["relation"].get("edgeId"), EDGE_ID)
        self.assertEqual(found["edge"]["identity"]["relation"].get("sourceNodeId"), "latent_a")
        self.assertEqual(found["edge"]["identity"]["relation"].get("targetNodeId"), "observed_b")
        self.assertEqual(found["path_edge"]["identity"]["relation"].get("edgeId"), PATH_EDGE_ID)
        self.assertEqual(found["path_edge"]["identity"]["relation"].get("sourceNodeId"), "latent_a")
        self.assertEqual(found["path_edge"]["identity"]["relation"].get("targetNodeId"), "observed_b")
        self.assertEqual(found["path_edge"].get("source", {}).get("artistClass"), "GeomPath")
        self.assertEqual(
            sum(
                obj.get("role") == "diagram_edge"
                and obj.get("identity", {}).get("relation", {}).get("diagramObjectId") == PATH_EDGE_ID
                for obj in self.objects
            ),
            1,
            "multi-vertex semantic path must remain one diagram edge object",
        )
        self.assertEqual(found["arrow"]["identity"]["relation"].get("edgeId"), EDGE_ID)
        self.assertEqual(found["arrow"]["identity"]["relation"].get("sourceNodeId"), "latent_a")
        self.assertEqual(found["arrow"]["identity"]["relation"].get("targetNodeId"), "observed_b")
        self.assertEqual(found["latent_label"]["identity"]["relation"].get("nodeId"), "latent_a")
        self.assertEqual(found["observed_label"]["identity"]["relation"].get("nodeId"), "observed_b")
        self.assertEqual(found["coefficient"]["identity"]["relation"].get("edgeId"), EDGE_ID)
        for obj in found.values():
            self.assertIn(
                f'data-fig-id="{obj["id"]}"',
                self.result["svg"],
                f'{obj["id"]} is present in the manifest but not selectable in the rendered SVG',
            )

    def test_lookalike_primitives_without_explicit_markers_stay_generic(self):
        ordinary_candidates = []
        for obj in self.objects:
            text = str(obj.get("currentProps", {}).get("text", ""))
            label = str(obj.get("label", ""))
            relation = obj.get("identity", {}).get("relation", {})
            layer_key = str(relation.get("layerKey", ""))
            if (
                re.search(r"ordinary (text|scatter|line|arrow)", f"{text} {label}", flags=re.I)
                or (
                    "layer-data" in layer_key
                    and ".scifigure_semantic_gid" not in layer_key
                    and str(obj.get("role", "")).startswith(("ggplot_GeomPoint", "ggplot_GeomSegment"))
                )
            ):
                ordinary_candidates.append(obj)
        self.assertTrue(ordinary_candidates, "fixture did not expose ordinary unmarked lookalike objects")
        for obj in ordinary_candidates:
            self.assertFalse(str(obj.get("role", "")).startswith("diagram_"), obj)
            self.assertNotIn("diagramId", obj.get("identity", {}).get("relation", {}), obj)

    def test_scientific_values_and_topology_are_readonly(self):
        readonly_by_label = {
            "latent": {"diagram_id", "diagram_type", "node_id", "x", "y"},
            "observed": {"diagram_id", "diagram_type", "node_id", "x", "y"},
            "edge": {"edge_id", "source_node_id", "target_node_id", "direction", "path", "vertices", "control_points"},
            "path_edge": {"edge_id", "source_node_id", "target_node_id", "direction", "path", "vertices", "control_points"},
            "arrow": {"edge_id", "source_node_id", "target_node_id", "direction", "path", "vertices", "control_points"},
            "latent_label": {"text", "node_id"},
            "observed_label": {"text", "node_id"},
            "coefficient": {"text", "edge_id", "coefficient", "value", "p_value", "pvalue", "significance"},
            "fit": {"text", "fit", "fit_indices", "cfi", "rmsea", "p_value", "pvalue"},
            "group": {"diagram_id", "diagram_type", "members", "node_ids"},
        }
        for label, readonly_props in readonly_by_label.items():
            role, diagram_object_id = EXPECTED_OBJECTS[label]
            obj = object_by_role_and_object_id(self.objects, role, diagram_object_id)
            self.assertIsNotNone(obj, f"missing {label} before readonly checks")
            editable = set(obj.get("editable", []))
            capabilities = capability_props(obj)
            self.assertTrue(obj.get("propertyCapabilities"), f"{label} lacks style capabilities: {obj}")
            self.assertTrue(
                all(item.get("patchMode") == "backend_patch" for item in obj.get("propertyCapabilities", [])),
                f"{label} has non-backend capability: {obj.get('propertyCapabilities')}",
            )
            self.assertFalse(
                editable & readonly_props,
                f"{label} exposes readonly props as editable: {sorted(editable & readonly_props)}",
            )
            self.assertFalse(
                capabilities & readonly_props,
                f"{label} exposes readonly props in propertyCapabilities: {sorted(capabilities & readonly_props)}",
            )

    def test_dedicated_style_edits_replay_without_identity_drift(self):
        targets = {
            label: object_by_role_and_object_id(self.objects, role, diagram_object_id)
            for label, (role, diagram_object_id) in EXPECTED_OBJECTS.items()
        }
        edits = [
            _backend_patch(targets["latent"], "facecolor", "#1188CC"),
            _backend_patch(targets["edge"], "color", "#CC3311"),
            _backend_patch(targets["arrow"], "color", "#228833"),
            _backend_patch(targets["latent_label"], "fontsize", 12.0),
            _backend_patch(targets["group"], "edgecolor", "#AA3377"),
        ]
        replayed = _run_r_renderer(self.source, edits)
        self.assertFalse(replayed["conflict"], replayed)
        self.assertEqual(len(replayed["applied"]), len(edits), replayed)
        replayed_objects = replayed["manifest"]["objects"]
        expected_values = {
            "latent": ("facecolor", "#1188CC"),
            "edge": ("color", "#CC3311"),
            "arrow": ("color", "#228833"),
            "latent_label": ("fontsize", 12.0),
            "group": ("edgecolor", "#AA3377"),
        }
        for label, (prop, value) in expected_values.items():
            role, diagram_object_id = EXPECTED_OBJECTS[label]
            baseline = targets[label]
            current = object_by_role_and_object_id(replayed_objects, role, diagram_object_id)
            self.assertIsNotNone(current, label)
            self.assertEqual(current["currentProps"].get(prop), value, current)
            self.assertEqual(current["stableKey"], baseline["stableKey"], current)
            self.assertEqual(current["fingerprint"], baseline["fingerprint"], current)
            self.assertEqual(current["identity"], baseline["identity"], current)
        compact_svg = replayed["svg"].upper()
        for color in ("#1188CC", "#CC3311", "#228833", "#AA3377"):
            self.assertIn(color, compact_svg)

    def test_mixed_scientific_or_topology_edit_fails_closed(self):
        coefficient = object_by_role_and_object_id(
            self.objects, "diagram_coefficient_label", "coef_a_b"
        )
        edge = object_by_role_and_object_id(
            self.objects, "diagram_edge", EDGE_ID
        )
        edits = [
            _backend_patch(edge, "color", "#00AA00"),
            _backend_patch(coefficient, "text", "beta = 9.99, p < 0.001"),
            _backend_patch(edge, "source_node_id", "observed_b"),
        ]
        rejected = _run_r_renderer(self.source, edits)
        self.assertTrue(rejected["conflict"], rejected)
        self.assertEqual(rejected["applied"], [], rejected)
        self.assertEqual(len(rejected["skipped"]), len(edits), rejected)
        rejected_edge = object_by_role_and_object_id(
            rejected["manifest"]["objects"], "diagram_edge", EDGE_ID
        )
        self.assertEqual(rejected_edge["currentProps"]["color"], edge["currentProps"]["color"])
        self.assertNotIn("#00AA00", rejected["svg"].upper())

    def test_tampered_edge_relation_is_rejected(self):
        edge = object_by_role_and_object_id(self.objects, "diagram_edge", EDGE_ID)
        tampered = _backend_patch(edge, "color", "#00AA00")
        tampered["identity"] = copy.deepcopy(tampered["identity"])
        tampered["identity"]["relation"]["sourceNodeId"] = "observed_b"
        rejected = _run_r_renderer(self.source, [tampered])
        self.assertTrue(rejected["conflict"], rejected)
        self.assertEqual(rejected["applied"], [], rejected)
        self.assertTrue(
            any(item.get("type") == "identity_mismatch" for item in rejected.get("warnings", [])),
            rejected,
        )

    def test_complete_diagram_identity_and_base64url_tokens_do_not_collide(self):
        script = r'''
library(ggplot2)

p <- ggplot() +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 1, y = 1), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.one", role = "node", object_id = "A"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 2, y = 2), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.two", role = "node", object_id = "A"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 3, y = 3), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.unicode", role = "node", object_id = "\u083E"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 4, y = 4), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.unicode", role = "node", object_id = "\u083F"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 5, y = 5), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.namespace", role = "node", object_id = "bw6k"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 6, y = 6), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "diagram.namespace", role = "node", object_id = "\u00E9"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 7, y = 7), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "x", role = "node", object_id = "y.a_diagram_node.a_z"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 8, y = 8), aes(x, y), shape = 21, size = 5, fill = "#88AADD", colour = "#224466"),
    diagram_id = "x.a_diagram_node.a_y", role = "node", object_id = "z"
  ) +
  coord_cartesian(clip = "off") +
  theme_void()
p
'''
        result = _run_r_renderer(script)
        nodes = [obj for obj in result["manifest"]["objects"] if obj.get("role") == "diagram_node"]
        self.assertEqual(len(nodes), 8, nodes)
        gids = [obj["id"] for obj in nodes]
        self.assertEqual(len(set(gids)), 8, gids)
        self.assertTrue(all(len(gid.split(".")) == 7 for gid in gids), gids)
        same_object = [
            obj for obj in nodes
            if obj.get("identity", {}).get("relation", {}).get("diagramObjectId") == "A"
        ]
        self.assertEqual(len(same_object), 2, same_object)
        self.assertNotEqual(same_object[0]["id"], same_object[1]["id"])
        namespace_nodes = {
            obj.get("identity", {}).get("relation", {}).get("diagramObjectId"): obj
            for obj in nodes
            if obj.get("identity", {}).get("relation", {}).get("diagramId") == "diagram.namespace"
        }
        self.assertEqual(set(namespace_nodes), {"bw6k", "\u00E9"}, namespace_nodes)
        self.assertNotEqual(namespace_nodes["bw6k"]["id"], namespace_nodes["\u00E9"]["id"])
        self.assertIn(".a_Ync2aw", namespace_nodes["bw6k"]["id"])
        self.assertIn(".b_w6k", namespace_nodes["\u00E9"]["id"])
        delimiter_nodes = [
            obj for obj in nodes
            if obj.get("identity", {}).get("relation", {}).get("diagramId")
            in {"x", "x.a_diagram_node.a_y"}
        ]
        self.assertEqual(len(delimiter_nodes), 2, delimiter_nodes)
        self.assertNotEqual(delimiter_nodes[0]["id"], delimiter_nodes[1]["id"])

    def test_duplicate_complete_diagram_identity_is_rejected(self):
        script = r'''
library(ggplot2)

p <- ggplot() +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 1, y = 1), aes(x, y), shape = 21, size = 5),
    diagram_id = "duplicate.diagram", role = "node", object_id = "same.node"
  ) +
  scifigure_semantic_layer(
    geom_point(data = data.frame(x = 2, y = 2), aes(x, y), shape = 21, size = 5),
    diagram_id = "duplicate.diagram", role = "node", object_id = "same.node"
  ) +
  coord_cartesian(clip = "off") +
  theme_void()
p
'''
        with self.assertRaisesRegex(AssertionError, "Duplicate R diagram GID"):
            _run_r_renderer(script)

    def test_clip_off_same_style_decoy_uses_verified_panel_and_draw_order(self):
        script = r'''
library(ggplot2)

marked <- data.frame(
  x = 0.75,
  y = 0.5,
  .scifigure_semantic_gid = paste0(
    "scifigure-sem-v1:diagram=decoy.test&type=sem&role=node&id=target"
  )
)
decoy <- data.frame(x = 0.25, y = 0.5)

p <- ggplot() +
  geom_point(
    data = decoy, aes(x, y), inherit.aes = FALSE,
    shape = 21, size = 7, fill = "#88AADD", colour = "#224466"
  ) +
  geom_point(
    data = marked, aes(x, y), inherit.aes = FALSE,
    shape = 21, size = 7, fill = "#88AADD", colour = "#224466"
  ) +
  coord_cartesian(xlim = c(0, 1), ylim = c(0, 1), clip = "off") +
  theme_void()
p
'''
        result = _run_r_renderer(script)
        node = object_by_role_and_object_id(result["manifest"]["objects"], "diagram_node", "target")
        self.assertIsNotNone(node, result)
        match = re.search(
            rf'<circle[^>]*data-fig-id="{re.escape(node["id"])}"[^>]*cx=\'([0-9.]+)\'',
            result["svg"],
        )
        self.assertIsNotNone(match, result["svg"])
        same_style_x = [
            float(value)
            for value in re.findall(
                r'<circle[^>]*cx=\'([0-9.]+)\'[^>]*fill: #88AADD',
                result["svg"],
            )
        ]
        self.assertGreaterEqual(len(same_style_x), 2, result["svg"])
        self.assertEqual(
            float(match.group(1)),
            max(same_style_x),
            "diagram GID was attached to the earlier decoy point",
        )


if __name__ == "__main__":
    unittest.main()

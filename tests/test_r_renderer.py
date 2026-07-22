import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Dict, List


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R_RENDERER = os.path.join(PROJECT_ROOT, "renderer", "r_renderer.R")
LEGACY_IDENTITY_FIXTURE = os.path.join(
    PROJECT_ROOT,
    "tests",
    "fixtures",
    "r_editing_baseline",
    "legacy_identity_v1.json",
)


def _rscript_bin() -> str:
    return (
        os.environ.get("RSCRIPT_BIN")
        or os.environ.get("R_BIN")
        or r"C:\Users\SZC\.conda\envs\Machine-learning\Scripts\Rscript.exe"
        if os.name == "nt"
        else "Rscript"
    )


def _process_env() -> dict:
    env = os.environ.copy()
    r_bin = _rscript_bin()
    env_root = os.path.dirname(os.path.dirname(r_bin)) if os.path.isabs(r_bin) else ""
    if env_root:
        extra_paths = [
            env_root,
            os.path.join(env_root, "Scripts"),
            os.path.join(env_root, "Library", "bin"),
            os.path.join(env_root, "Library", "mingw-w64", "bin"),
            os.path.join(env_root, "Lib", "R", "bin"),
            os.path.join(env_root, "Lib", "R", "bin", "x64"),
        ]
        env["PATH"] = os.pathsep.join(extra_paths + [env.get("PATH", "")])
    return env


def _run_r_renderer(script: str, edit_log=None, render_options=None, extra_payload=None) -> Dict[str, Any]:
    payload = {
        "script": script,
        "editLog": edit_log or [],
        "renderOptions": render_options or {"width_in": 6, "height_in": 4},
    }
    if extra_payload:
        payload.update(extra_payload)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        payload_file = f.name

    try:
        proc = subprocess.run(
            [_rscript_bin(), "--vanilla", R_RENDERER, "--payload-file", payload_file],
            cwd=PROJECT_ROOT,
            env=_process_env(),
            text=True,
            encoding="utf-8",
            errors="strict",
            capture_output=True,
            timeout=30,
        )
    finally:
        try:
            os.unlink(payload_file)
        except OSError:
            pass

    stdout = proc.stdout.strip()
    if not stdout:
        raise AssertionError(f"R renderer returned no stdout. code={proc.returncode} stderr={proc.stderr}")
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"R renderer did not return JSON. code={proc.returncode} stdout={stdout[:500]} stderr={proc.stderr}") from exc
    if result.get("status") != "success":
        raise AssertionError(f"R renderer failed: {result}")
    return result


def _objects(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    return result["manifest"]["objects"]


def _object(result: Dict[str, Any], gid: str) -> Dict[str, Any]:
    return next(obj for obj in _objects(result) if obj["id"] == gid)


def _backend_patch(obj: Dict[str, Any], prop: str, value: Any) -> Dict[str, Any]:
    return {
        "gid": obj["id"],
        "prop": prop,
        "value": value,
        "mode": "backend_patch",
        "stableKey": obj["stableKey"],
        "fingerprint": obj["fingerprint"],
        "fingerprintVersion": obj["fingerprintVersion"],
        "identity": obj["identity"],
    }


def _decode_r_v2_fingerprint(fingerprint: str) -> Dict[str, Any]:
    if not fingerprint.startswith("r-v2:"):
        raise AssertionError(f"Expected an r-v2 fingerprint, got {fingerprint!r}")
    return json.loads(base64.b64decode(fingerprint[len("r-v2:"):]).decode("utf-8"))


def _nested_keys(value: Any) -> set:
    if isinstance(value, dict):
        keys = set(value)
        for item in value.values():
            keys.update(_nested_keys(item))
        return keys
    if isinstance(value, list):
        keys = set()
        for item in value:
            keys.update(_nested_keys(item))
        return keys
    return set()


@unittest.skipUnless(os.path.exists(_rscript_bin()), "Rscript is not available")
class TestRRenderer(unittest.TestCase):
    def test_frozen_legacy_identity_fixture_replays_without_version_migration(self):
        with open(LEGACY_IDENTITY_FIXTURE, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)

        self.assertEqual(fixture["fixtureVersion"], 1)
        self.assertEqual(fixture["contract"], "r-manifest-before-fingerprint-v2")
        self.assertEqual(fixture["sourceCommit"], "c29e93d")
        frozen_payload = {
            "manifestExcerpt": fixture["manifestExcerpt"],
            "persistedEditLog": fixture["persistedEditLog"],
        }
        canonical_payload = json.dumps(
            frozen_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.assertEqual(
            hashlib.sha256(canonical_payload).hexdigest(),
            fixture["fixturePayloadSha256"],
        )

        frozen_objects = fixture["manifestExcerpt"]["objects"]
        self.assertTrue(frozen_objects)
        legacy_protocol_json = json.dumps(frozen_payload, ensure_ascii=False)
        self.assertNotIn('"fingerprintVersion"', legacy_protocol_json)
        self.assertNotIn('"fingerprint"', legacy_protocol_json)

        result = _run_r_renderer(fixture["script"], fixture["persistedEditLog"])
        for frozen in frozen_objects:
            replayed = _object(result, frozen["id"])
            self.assertEqual(replayed["currentProps"]["color"], frozen["currentProps"]["color"])
            frozen_identity = frozen["identity"]
            replayed_identity = replayed["identity"]
            for key, value in frozen_identity.items():
                if key == "relation":
                    continue
                self.assertEqual(replayed_identity.get(key), value)

            frozen_relation = frozen_identity["relation"]
            replayed_relation = replayed_identity["relation"]
            for key, value in frozen_relation.items():
                self.assertEqual(replayed_relation.get(key), value)
            self.assertLessEqual(
                set(replayed_relation) - set(frozen_relation),
                {"scaleKey", "guideKey"},
            )


    def test_frozen_legacy_identity_rejects_semantic_group_drift(self):
        with open(LEGACY_IDENTITY_FIXTURE, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)

        drifted_script = fixture["script"].replace(
            'group=c("A", "A", "B", "B")',
            'group=c("C", "C", "B", "B")',
        )
        self.assertNotEqual(drifted_script, fixture["script"])
        drifted = _run_r_renderer(drifted_script, fixture["persistedEditLog"])
        drifted_target = _object(drifted, "r.group.color.0.0")
        frozen_target = fixture["manifestExcerpt"]["objects"][0]
        self.assertNotEqual(drifted_target["identity"], frozen_target["identity"])
        self.assertNotEqual(
            drifted_target["currentProps"]["color"],
            fixture["persistedEditLog"][0]["value"],
            "R-WP2 must reject an old group edit when the same ordinal gid now identifies another group",
        )
        self.assertTrue(drifted["conflict"])
        self.assertEqual(drifted["applied"], [])
        self.assertEqual(drifted["skipped"], fixture["persistedEditLog"])
        self.assertTrue(any(
            warning.get("type") == "identity_mismatch"
            and warning.get("gid") == "r.group.color.0.0"
            for warning in drifted["warnings"]
            if isinstance(warning, dict)
        ))

    def test_frozen_legacy_identity_uniquely_remaps_after_factor_reorder(self):
        with open(LEGACY_IDENTITY_FIXTURE, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)

        reordered_script = fixture["script"].replace(
            "p <- ggplot",
            'df$group <- factor(df$group, levels=c("B", "A"))\np <- ggplot',
        )
        self.assertNotEqual(reordered_script, fixture["script"])
        reordered = _run_r_renderer(reordered_script, fixture["persistedEditLog"])
        group_a = next(
            obj for obj in _objects(reordered)
            if obj.get("identity", {}).get("relation", {}).get("groupKey") == "A"
        )
        group_b = next(
            obj for obj in _objects(reordered)
            if obj.get("identity", {}).get("relation", {}).get("groupKey") == "B"
        )
        self.assertEqual(group_a["id"], "r.group.color.0.1")
        self.assertEqual(group_a["currentProps"]["color"], fixture["persistedEditLog"][0]["value"])
        self.assertNotEqual(group_b["currentProps"]["color"], fixture["persistedEditLog"][0]["value"])
        self.assertFalse(reordered["conflict"])
        self.assertEqual(reordered["skipped"], [])
        self.assertEqual(reordered["applied"][0]["gid"], "r.group.color.0.0")
        self.assertEqual(reordered["applied"][0]["resolvedGid"], "r.group.color.0.1")

    def test_v2_identity_rejects_duplicate_layer_candidates_before_apply(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_line() + geom_line() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        target = _object(baseline, "r.layer.0")
        patch = {
            "gid": target["id"],
            "prop": "color",
            "value": "#CC0000",
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        rejected = _run_r_renderer(script, [patch])
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(rejected["skipped"], [patch])
        self.assertTrue(any(
            warning.get("type") == "ambiguous_identity"
            for warning in rejected["warnings"]
            if isinstance(warning, dict)
        ))
        self.assertNotEqual(_object(rejected, "r.layer.0")["currentProps"]["color"], "#CC0000")
        self.assertNotEqual(_object(rejected, "r.layer.1")["currentProps"]["color"], "#CC0000")

    def test_v2_identity_uniquely_remaps_layer_after_insertion(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + theme_classic()
p
"""
        shifted_script = baseline_script.replace(
            "+ geom_point(size=3)",
            "+ geom_hline(yintercept=2) + geom_point(size=3)",
        )
        baseline = _run_r_renderer(baseline_script)
        target = _object(baseline, "r.layer.0")
        patch = {
            "gid": target["id"],
            "prop": "color",
            "value": "#2CA02C",
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        shifted = _run_r_renderer(shifted_script, [patch])
        shifted_target = next(obj for obj in _objects(shifted) if obj.get("role") == target.get("role"))
        self.assertEqual(shifted_target["id"], "r.layer.1")
        self.assertEqual(shifted_target["currentProps"]["color"], "#2CA02C")
        self.assertNotEqual(_object(shifted, "r.layer.0")["currentProps"].get("color"), "#2CA02C")
        self.assertFalse(shifted["conflict"])
        self.assertEqual(shifted["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(shifted["applied"][0]["resolvedGid"], "r.layer.1")

    def test_v2_tick_identity_follows_facet_key_after_panel_reorder(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(
  x=rep(c("A", "B"), 2), y=c(1, 3, 2, 4),
  facet=rep(c("F1", "F2"), each=2)
)
p <- ggplot(df, aes(x, y)) + geom_col() + facet_wrap(~facet) + theme_classic()
p
"""
        reordered_script = baseline_script.replace(
            "p <- ggplot",
            'df$facet <- factor(df$facet, levels=c("F2", "F1"))\np <- ggplot',
        )
        baseline = _run_r_renderer(baseline_script)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("kind") == "xtick"
            and obj.get("identity", {}).get("relation", {}).get("facetKey") == "facet=F1"
            and obj.get("currentProps", {}).get("text") == "A"
        )
        patch = {
            "gid": target["id"],
            "prop": "fontsize",
            "value": 15,
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        reordered = _run_r_renderer(reordered_script, [patch])
        self.assertFalse(reordered["conflict"])
        self.assertEqual(reordered["applied"][0]["gid"], target["id"])
        self.assertEqual(reordered["applied"][0]["resolvedGid"], "xtick.1.0")
        remapped = next(obj for obj in _objects(reordered) if obj.get("stableKey") == target["stableKey"])
        self.assertEqual(remapped["id"], "xtick.1.0")
        self.assertEqual(remapped["currentProps"]["fontsize"], 15)

    def test_v2_fingerprints_stay_stable_for_group_panel_guide_text_and_layer_styles(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(1:2, 2), y=c(1, 3, 2, 4),
  group=c("A", "A", "B", "B"), facet=c("F1", "F1", "F2", "F2")
)
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=3) + facet_wrap(~facet) +
  labs(title="Identity stability") + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_objects = _objects(baseline)
        targets = [
            (_object(baseline, "title.0"), "fontsize", 17),
            (_object(baseline, "legend.0"), "markerscale", 1.4),
            (next(obj for obj in baseline_objects if obj.get("identity", {}).get("relation", {}).get("dataKey") == "legend:color:A"), "text", "Treatment A"),
            (next(obj for obj in baseline_objects if obj.get("identity", {}).get("relation", {}).get("groupKey") == "A"), "color", "#2CA02C"),
            (next(obj for obj in baseline_objects if obj.get("kind") == "subplot" and obj.get("identity", {}).get("relation", {}).get("facetKey") == "facet=F1"), "aspect", 1.2),
            (_object(baseline, "r.layer.0"), "size", 5),
        ]
        patches = [{
            "gid": obj["id"],
            "prop": prop,
            "value": value,
            "mode": "backend_patch",
            "stableKey": obj["stableKey"],
            "fingerprint": obj["fingerprint"],
            "fingerprintVersion": obj["fingerprintVersion"],
            "identity": obj["identity"],
        } for obj, prop, value in targets]
        patched = _run_r_renderer(script, patches)
        self.assertFalse(patched["conflict"])
        patched_by_stable_key = {obj["stableKey"]: obj for obj in _objects(patched)}
        for baseline_obj, _, _ in targets:
            self.assertEqual(baseline_obj["fingerprintVersion"], 2)
            patched_obj = patched_by_stable_key[baseline_obj["stableKey"]]
            self.assertEqual(patched_obj["stableKey"], baseline_obj["stableKey"])
            self.assertEqual(patched_obj["fingerprint"], baseline_obj["fingerprint"])

    def test_v2_fingerprint_is_compact_canonical_structure_without_style_fields(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) + geom_point(size=4) + theme_classic()
p
"""
        result = _run_r_renderer(script)
        target = _object(result, "r.layer.0")
        fingerprint = target["fingerprint"]
        self.assertTrue(fingerprint.startswith("r-v2:"))
        encoded = fingerprint[len("r-v2:"):]
        self.assertFalse(any(character.isspace() for character in encoded))
        decoded = base64.b64decode(encoded).decode("utf-8")
        structure = json.loads(decoded)
        self.assertEqual(
            decoded,
            json.dumps(structure, ensure_ascii=False, separators=(",", ":")),
        )

        def nested_keys(value):
            if isinstance(value, dict):
                return set(value).union(*(nested_keys(item) for item in value.values()))
            if isinstance(value, list):
                return set().union(*(nested_keys(item) for item in value)) if value else set()
            return set()

        self.assertTrue({"kind", "role", "stableKey", "semanticKey", "seriesKey"}.issubset(structure))
        self.assertTrue(
            nested_keys(structure).isdisjoint({
                "color", "colour", "facecolor", "edgecolor", "linewidth",
                "fontsize", "fontfamily", "fontweight", "fontstyle", "alpha",
            })
        )

    def test_v2_layer_identity_rejects_global_mapping_drift(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), z=c(5, 2, 4, 1))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + theme_classic()
p
"""
        drifted_script = baseline_script.replace("aes(x, y)", "aes(x, z)")
        baseline = _run_r_renderer(baseline_script)
        target = _object(baseline, "r.layer.0")
        patch = {
            "gid": target["id"],
            "prop": "color",
            "value": "#2CA02C",
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        drifted = _run_r_renderer(drifted_script, [patch])
        self.assertTrue(drifted["conflict"])
        self.assertEqual(drifted["applied"], [])
        self.assertEqual(drifted["skipped"], [patch])
        self.assertTrue(any(
            warning.get("type") == "identity_mismatch"
            for warning in drifted["warnings"]
            if isinstance(warning, dict)
        ))
        self.assertNotEqual(_object(drifted, "r.layer.0")["currentProps"]["color"], "#2CA02C")

    def test_v2_layer_subset_filter_drift_changes_identity_or_rejects_replay(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 2, 3, 4, 5, 6), group=rep(c("A", "B"), each=3))
p <- ggplot(df, aes(x, y)) +
  geom_point(data=subset(df, group=="A"), color="#1F78B4", size=3) +
  theme_classic()
p
"""
        drifted_script = baseline_script.replace('group=="A"', 'group=="B"')
        baseline = _run_r_renderer(baseline_script)
        baseline_layer = _object(baseline, "r.layer.0")
        drifted_unpatched = _run_r_renderer(drifted_script)
        drifted_layer = _object(drifted_unpatched, "r.layer.0")
        identity_changed = (
            drifted_layer["stableKey"] != baseline_layer["stableKey"]
            or drifted_layer["fingerprint"] != baseline_layer["fingerprint"]
            or drifted_layer["identity"] != baseline_layer["identity"]
        )

        replayed = _run_r_renderer(drifted_script, [
            _backend_patch(baseline_layer, "color", "#CC0000"),
        ])
        replayed_layer = _object(replayed, "r.layer.0")
        rejected_replay = (
            replayed["conflict"]
            and replayed["applied"] == []
            and replayed["skipped"]
            and replayed_layer["currentProps"].get("color") != "#CC0000"
        )

        self.assertTrue(
            identity_changed or rejected_replay,
            "Changing a layer-local subset from group A to B must either alter v2 identity evidence or reject replay.",
        )
        self.assertNotEqual(
            replayed_layer["currentProps"].get("color"),
            "#CC0000",
            "R-WP2 must not silently apply a group A layer edit to the group B subset.",
        )

    def test_v2_conditional_text_without_data_key_rejects_content_row_drift(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2, 4, 3), label=c("A", "B", "C"))
p <- ggplot(df, aes(x, y, label=label)) + geom_text() + theme_classic()
p
"""
        drifted_script = baseline_script.replace(
            'label=c("A", "B", "C")',
            'label=c("C", "A", "B")',
        )
        baseline = _run_r_renderer(baseline_script)
        target = next(obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_annotation")
        self.assertTrue(target["currentProps"]["dataKey"].startswith("semantic:"))
        self.assertEqual(target["currentProps"]["identityStability"], "stable")

        drifted = _run_r_renderer(drifted_script, [
            _backend_patch(target, "text", "Alpha"),
        ])
        drifted_text = [obj for obj in _objects(drifted) if obj["id"].startswith("r.text.")]
        self.assertTrue(drifted["conflict"])
        self.assertEqual(drifted["applied"], [])
        self.assertEqual(len(drifted["skipped"]), 1)
        self.assertTrue(any(
            warning.get("type") in {"ambiguous_identity", "identity_mismatch"}
            for warning in drifted["warnings"]
            if isinstance(warning, dict)
        ))
        self.assertNotIn("Alpha", [obj["currentProps"]["text"] for obj in drifted_text])

    def test_v2_single_text_without_explicit_id_rejects_source_content_drift(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(x=1, y=2, label="A")
p <- ggplot(df, aes(x, y, label=label)) + geom_text() + theme_classic()
p
"""
        drifted_script = baseline_script.replace('label="A"', 'label="B"')
        baseline = _run_r_renderer(baseline_script)
        target = next(obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_annotation")

        replayed = _run_r_renderer(drifted_script, [
            _backend_patch(target, "color", "#CC0000"),
        ])

        self.assertTrue(replayed["conflict"])
        self.assertEqual(replayed["applied"], [])
        self.assertEqual(len(replayed["skipped"]), 1)
        self.assertNotEqual(
            next(obj for obj in _objects(replayed) if obj.get("role") == "ggplot_text_annotation")["currentProps"]["color"],
            "#CC0000",
        )

    def test_v2_duplicate_text_rows_without_unique_semantics_are_not_replayable(self):
        script = """
library(ggplot2)
df <- data.frame(x=c(1, 1), y=c(2, 2), label=c("A", "A"))
p <- ggplot(df, aes(x, y, label=label)) + geom_text() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        targets = [obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_annotation"]
        self.assertEqual(len(targets), 2)
        for target in targets:
            self.assertIsNone(target["currentProps"]["dataKey"])
            self.assertEqual(target["currentProps"]["identityStability"], "unsupported")
            self.assertTrue(all(
                capability["replay"] == "unsupported"
                for capability in target["propertyCapabilities"]
            ))

        replayed = _run_r_renderer(script, [
            _backend_patch(targets[0], "color", "#CC0000"),
        ])
        self.assertTrue(replayed["conflict"])
        self.assertEqual(replayed["applied"], [])

    def test_v2_merged_color_fill_legend_identity_is_deduplicated_and_order_stable(self):
        color_first = """
library(ggplot2)
df <- data.frame(x=c("A", "B"), y=c(1, 2), group=c("A", "B"))
p <- ggplot(df, aes(x, y, color=group, fill=group)) +
  geom_point(shape=21, size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Group") +
  theme_classic()
p
"""
        fill_first = color_first.replace(
            'scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +\n  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Group")',
            'scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Group") +\n  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group")',
        )
        baseline = _run_r_renderer(color_first)
        reordered = _run_r_renderer(fill_first)
        baseline_items = [obj for obj in _objects(baseline) if obj.get("role") == "legend_text"]
        reordered_items = [obj for obj in _objects(reordered) if obj.get("role") == "legend_text"]
        self.assertEqual([obj["currentProps"]["text"] for obj in baseline_items], ["A", "B"])
        self.assertEqual(len(reordered_items), 2)
        self.assertEqual(
            {obj["stableKey"] for obj in baseline_items},
            {obj["stableKey"] for obj in reordered_items},
        )
        for obj in baseline_items:
            relation = obj["identity"]["relation"]
            self.assertEqual(relation["aesthetic"], "color+fill")
            self.assertIn("ggplot-scale:color", relation["scaleKey"])
            self.assertIn("ggplot-scale:fill", relation["scaleKey"])
            self.assertTrue(relation["guideKey"].startswith("ggplot-guide:"))

        target = next(obj for obj in baseline_items if obj["currentProps"]["text"] == "A")
        patch = {
            "gid": target["id"],
            "prop": "text",
            "value": "Treatment A",
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        replayed = _run_r_renderer(fill_first, [patch])
        self.assertFalse(replayed["conflict"])
        replayed_items = [obj for obj in _objects(replayed) if obj.get("role") == "legend_text"]
        self.assertEqual([obj["currentProps"]["text"] for obj in replayed_items], ["Treatment A", "B"])
        self.assertEqual(len(replayed_items), 2)

    def test_v2_same_mapping_with_distinct_guide_titles_stays_separate(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:2, y=1:2, group=c("A", "B"))
p <- ggplot(df, aes(x, y, color=group, fill=group)) +
  geom_point(shape=21, size=4) +
  scale_color_manual(values=c(A="#111111", B="#222222"), name="Outline group") +
  scale_fill_manual(values=c(A="#AAAAAA", B="#BBBBBB"), name="Fill group") +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        legend_items = [obj for obj in _objects(result) if obj.get("role") == "legend_text"]
        guide_keys = {
            obj["identity"]["relation"]["guideKey"]
            for obj in legend_items
        }

        self.assertEqual(len(legend_items), 4)
        self.assertEqual(len(guide_keys), 2)
        self.assertEqual(len({obj["stableKey"] for obj in legend_items}), 4)

    def test_v2_parallel_guide_reorder_replays_legend_text_by_mapping_identity(self):
        color_first = """
library(ggplot2)
df <- data.frame(
  x=c("A", "B"), y=c(1, 2),
  group=c("A", "B"), condition=c("A", "B")
)
p <- ggplot(df, aes(x, y, color=group, fill=condition)) +
  geom_point(shape=21, size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +
  theme_classic()
p
"""
        fill_first = color_first.replace(
            'scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +\n  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition")',
            'scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +\n  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group")',
        )
        baseline = _run_r_renderer(color_first)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("role") == "legend_text"
            and obj.get("identity", {}).get("relation", {}).get("dataKey") == "legend:color:A"
        )
        patch = {
            "gid": target["id"],
            "prop": "text",
            "value": "Group A",
            "mode": "backend_patch",
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
            "identity": target["identity"],
        }
        replayed = _run_r_renderer(fill_first, [patch])
        self.assertFalse(replayed["conflict"])
        remapped = next(
            obj for obj in _objects(replayed)
            if obj.get("stableKey") == target["stableKey"]
        )
        fill_a = next(
            obj for obj in _objects(replayed)
            if obj.get("role") == "legend_text"
            and obj.get("identity", {}).get("relation", {}).get("dataKey") == "legend:fill:A"
        )
        self.assertEqual(remapped["currentProps"]["text"], "Group A")
        self.assertEqual(fill_a["currentProps"]["text"], "A")

    def test_v2_parallel_reordered_guides_are_not_ordinal_only_for_legend_text(self):
        color_first = """
library(ggplot2)
df <- data.frame(
  x=c("A", "B"), y=c(1, 2),
  group=c("A", "B"), condition=c("A", "B")
)
p <- ggplot(df, aes(x, y, color=group, fill=condition)) +
  geom_point(shape=21, size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +
  theme_classic()
p
"""
        fill_first = color_first.replace(
            'scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +\n  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition")',
            'scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +\n  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group")',
        )
        baseline = _run_r_renderer(color_first)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("role") == "legend_text"
            and obj.get("identity", {}).get("relation", {}).get("dataKey") == "legend:color:A"
        )
        self.assertEqual(target["id"], "legend_text.0.0")
        self.assertIn("legend:color:A", target["stableKey"])

        replayed = _run_r_renderer(fill_first, [
            _backend_patch(target, "text", "Group A"),
        ])
        self.assertFalse(replayed["conflict"])
        self.assertEqual(replayed["applied"][0]["resolvedGid"], "legend_text.0.2")
        remapped = _object(replayed, "legend_text.0.2")
        ordinal_match = _object(replayed, "legend_text.0.0")
        self.assertEqual(remapped["identity"]["relation"]["dataKey"], "legend:color:A")
        self.assertEqual(remapped["currentProps"]["text"], "Group A")
        self.assertEqual(ordinal_match["identity"]["relation"]["dataKey"], "legend:fill:A")
        self.assertEqual(ordinal_match["currentProps"]["text"], "A")

    def test_v2_blank_facet_panel_tick_fallback_keys_are_collision_free(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c("A", "B"),
  y=c(1, 2),
  facet=factor(c("F1", "F1"), levels=c("F1", "F2"))
)
p <- ggplot(df, aes(x, y)) + geom_col() + facet_wrap(~facet, drop=FALSE) + theme_classic()
p
"""
        result = _run_r_renderer(script)
        panels = [obj for obj in _objects(result) if obj.get("kind") == "subplot"]
        ticks = [obj for obj in _objects(result) if obj.get("kind") in {"xtick", "ytick"}]
        tick_keys = [obj["stableKey"] for obj in ticks]
        panel_keys = [obj["stableKey"] for obj in panels]
        tick_identity_tuples = [
            (
                obj["identity"]["relation"].get("facetKey"),
                obj["identity"]["relation"].get("axisKey"),
                obj["identity"]["relation"].get("dataKey"),
            )
            for obj in ticks
        ]

        self.assertEqual({panel["identity"]["relation"]["facetKey"] for panel in panels}, {"facet=F1", "facet=F2"})
        self.assertEqual(len(panel_keys), len(set(panel_keys)))
        self.assertEqual(len(tick_keys), len(set(tick_keys)))
        self.assertEqual(len(tick_identity_tuples), len(set(tick_identity_tuples)))
        f1_a = next(
            obj for obj in ticks
            if obj["identity"]["relation"].get("facetKey") == "facet=F1"
            and obj["identity"]["relation"].get("axisKey") == "x"
            and obj["currentProps"]["text"] == "A"
        )
        f2_a = next(
            obj for obj in ticks
            if obj["identity"]["relation"].get("facetKey") == "facet=F2"
            and obj["identity"]["relation"].get("axisKey") == "x"
            and obj["currentProps"]["text"] == "A"
        )
        self.assertNotEqual(f1_a["stableKey"], f2_a["stableKey"])
        self.assertNotEqual(f1_a["fingerprint"], f2_a["fingerprint"])

    def test_v2_fingerprint_payload_is_single_line_canonical_and_style_free(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4, alpha=0.35) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728")) +
  theme_classic(base_size=18)
p
"""
        result = _run_r_renderer(script)
        targets = [
            obj for obj in _objects(result)
            if obj.get("id") in {"r.layer.0", "r.group.color.0.0", "legend_text.0.0"}
        ]
        self.assertEqual(len(targets), 3)
        style_fields = {
            "color", "colour", "facecolor", "edgecolor", "linewidth", "size",
            "fontsize", "fontfamily", "fontweight", "fontstyle", "alpha",
            "markerscale", "linestyle",
        }
        for obj in targets:
            fingerprint = obj["fingerprint"]
            self.assertTrue(fingerprint.startswith("r-v2:"))
            self.assertEqual(fingerprint, fingerprint.splitlines()[0])
            payload = _decode_r_v2_fingerprint(fingerprint)
            decoded = base64.b64decode(fingerprint[len("r-v2:"):]).decode("utf-8")
            self.assertEqual(decoded, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            self.assertTrue({"kind", "role", "stableKey", "semanticKey", "seriesKey"}.issubset(payload))
            self.assertTrue(_nested_keys(payload).isdisjoint(style_fields))

    def test_v2_merged_color_fill_guide_identity_stays_coherent(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B"), y=c(1, 2), group=c("A", "B"))
p <- ggplot(df, aes(x, y, color=group, fill=group)) +
  geom_point(shape=21, size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Group") +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        legend_items = [obj for obj in _objects(result) if obj.get("role") == "legend_text"]
        color_groups = [obj for obj in _objects(result) if obj["id"].startswith("r.group.color.")]
        fill_groups = [obj for obj in _objects(result) if obj["id"].startswith("r.group.fill.")]
        self.assertEqual([obj["currentProps"]["text"] for obj in legend_items], ["A", "B"])
        self.assertEqual(len(color_groups), 2)
        self.assertEqual(len(fill_groups), 2)
        self.assertEqual(len({obj["stableKey"] for obj in legend_items}), 2)

        for label in ["A", "B"]:
            legend_item = next(obj for obj in legend_items if obj["currentProps"]["text"] == label)
            color_group = next(obj for obj in color_groups if obj["identity"]["relation"]["groupKey"] == label)
            fill_group = next(obj for obj in fill_groups if obj["identity"]["relation"]["groupKey"] == label)
            legend_relation = legend_item["identity"]["relation"]
            self.assertEqual(legend_relation["aesthetic"], "color+fill")
            self.assertEqual(color_group["identity"]["relation"]["guideKey"], legend_relation["guideKey"])
            self.assertEqual(fill_group["identity"]["relation"]["guideKey"], legend_relation["guideKey"])
            self.assertIn(color_group["identity"]["relation"]["scaleKey"], legend_relation["scaleKey"])
            self.assertIn(fill_group["identity"]["relation"]["scaleKey"], legend_relation["scaleKey"])
            self.assertIn(label, legend_relation["dataKey"])

    def test_r_shadow_identity_is_stable_across_style_edits(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_line() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#CC0000", "mode": "backend_patch"},
        ])
        baseline_objects = _objects(baseline)
        instance_keys = [obj["identity"]["instanceKey"] for obj in baseline_objects]
        self.assertEqual(len(instance_keys), len(set(instance_keys)))
        for obj in baseline_objects:
            capability_props = [item["prop"] for item in obj["propertyCapabilities"]]
            self.assertEqual(sorted(obj["editable"]), sorted(capability_props))
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertEqual(
            baseline_layer["identity"]["instanceKey"],
            patched_layer["identity"]["instanceKey"],
        )
        self.assertEqual(
            baseline_layer["identity"]["semanticKey"],
            patched_layer["identity"]["semanticKey"],
        )
        self.assertEqual(
            baseline_layer["identity"]["seriesKey"],
            patched_layer["identity"]["seriesKey"],
        )
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprintVersion"], 2)
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        color_capability = next(
            capability for capability in patched_layer["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertEqual(color_capability["patchMode"], "backend_patch")
        self.assertEqual(color_capability["replay"], "stable")
        self.assertIn("object", color_capability["scopes"])
        self.assertIn("cross_figure", color_capability["scopes"])

    def test_text_theme_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic() + labs(title="Old", x="X", y="Y")
p
"""
        result = _run_r_renderer(script, [
            {"gid": "title.0", "prop": "text", "value": "Updated title", "mode": "backend_patch"},
            {"gid": "title.0", "prop": "fontsize", "value": 18, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_labelsize", "value": 14, "mode": "backend_patch"},
        ])
        self.assertIn("Updated title", result["svg"])
        self.assertEqual(_object(result, "title.0")["currentProps"]["fontsize"], 18)
        self.assertEqual(_object(result, "axis.x.0")["currentProps"]["tick_labelsize"], 14)

    def test_r_individual_tick_objects_are_style_editable(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B", "C"), y=c(1, 3, 2))
p <- ggplot(df, aes(x, y)) + geom_col() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "xtick.0.0", "prop": "fontsize", "value": 13, "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontweight", "value": "bold", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "fontstyle", "value": "italic", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "xtick.0.0", "prop": "rotation", "value": 35, "mode": "backend_patch"},
        ])
        xtick = _object(result, "xtick.0.0")
        ytick = _object(result, "ytick.0.0")
        axis_x = _object(result, "axis.x.0")
        axis_y = _object(result, "axis.y.0")

        self.assertIn("fontsize", xtick["editable"])
        self.assertIn("fontfamily", xtick["editable"])
        self.assertIn("color", xtick["editable"])
        self.assertIn("rotation", xtick["editable"])
        self.assertIn("fontsize", ytick["editable"])
        self.assertEqual(xtick["currentProps"]["fontsize"], 13)
        self.assertEqual(xtick["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(xtick["currentProps"]["fontweight"], "bold")
        self.assertEqual(xtick["currentProps"]["fontstyle"], "italic")
        self.assertEqual(xtick["currentProps"]["color"], "#AA0000")
        self.assertEqual(xtick["currentProps"]["rotation"], 35)
        # ggplot applies tick text styling at the axis theme level.
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 13)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "Times New Roman")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "#AA0000")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 35)
        self.assertIn("tick_labelcolor", axis_x["editable"])
        self.assertIn("tick_labelcolor", axis_y["editable"])

    def test_axis_label_and_tick_style_are_separate(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic() + labs(x="Old X", y="Old Y")
p
"""
        result = _run_r_renderer(script, [
            {"gid": "axis.y.0", "prop": "label", "value": "Updated Y", "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "label_color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "label_fontsize", "value": 17, "mode": "backend_patch"},
            {"gid": "axis.y.0", "prop": "tick_labelcolor", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        axis_y = _object(result, "axis.y.0")
        ylabel = _object(result, "ylabel.0")

        self.assertEqual(axis_y["currentProps"]["label"], "Updated Y")
        self.assertEqual(axis_y["currentProps"]["label_color"], "#AA0000")
        self.assertEqual(axis_y["currentProps"]["label_fontsize"], 17)
        self.assertEqual(axis_y["currentProps"]["tick_labelcolor"], "#2CA02C")
        self.assertEqual(ylabel["currentProps"]["text"], "Updated Y")
        self.assertEqual(ylabel["currentProps"]["color"], "#AA0000")
        self.assertIn("Updated Y", result["svg"])

    def test_layer_style_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + geom_line() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "linewidth", "value": 3, "mode": "backend_patch"},
        ])
        self.assertIn('data-fig-id="r.layer.0"', result["svg"])
        self.assertIn('data-fig-id="r.layer.1"', result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "r.layer.1")["currentProps"]["linewidth"], 3)

    def test_manual_scale_palette_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1,4,2,6,3,7), group=rep(c("A","B"),3))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.group.color.0.1", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        palettes = result["manifest"]["palettes"]
        bindings = result["manifest"]["bindings"]
        self.assertEqual(len(palettes), 2)
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "r.group.color.0.1")["currentProps"]["color"], "#2CA02C")
        target_binding = next(binding for binding in bindings if binding["paletteId"] == "r.scale.color.0.1")
        self.assertEqual(target_binding["targetMode"], "exact")
        self.assertEqual(target_binding["targets"], [{
            "gid": "r.group.color.0.1",
            "prop": "color",
            "instanceKey": "r:container:r.group.color.0.1",
            "seriesKey": "r-series:color:B",
            "match": "scale_key",
            "confidence": "exact",
        }])

    def test_default_discrete_scale_exposes_layer_group_panel_aesthetic_identity(self):
        script = """
options(warn=2)
library(ggplot2)
df <- expand.grid(panel=c("P1", "P2"), group=c("A", "B"), x=1:2)
df$y <- seq_len(nrow(df))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  facet_wrap(~panel) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.group.color.0.1", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])

        group_a = _object(baseline, "r.group.color.0.0")
        group_b = _object(baseline, "r.group.color.0.1")
        relation = group_b["identity"]["relation"]
        self.assertEqual(relation["aesthetic"], "color")
        self.assertEqual(relation["groupKey"], "B")
        self.assertEqual(relation["scaleId"], "r.scale.color.0")
        self.assertEqual(relation["guideId"], "legend.0")
        self.assertEqual(relation["legendId"], "legend.0")
        self.assertEqual(relation["layerIds"], ["r.layer.0"])
        self.assertEqual(relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertEqual(group_b["identity"]["semanticKey"], "ggplot_group:color:B")
        self.assertEqual(group_b["identity"]["seriesKey"], "r-series:color:B")
        self.assertTrue(group_b["currentProps"]["svgSelectable"])
        color_capability = next(
            capability for capability in group_b["propertyCapabilities"]
            if capability["prop"] == "color"
        )
        self.assertNotIn("subplot", color_capability["scopes"])
        self.assertIn("figure", color_capability["scopes"])
        self.assertIn('data-fig-id="r.group.color.0.0"', baseline["svg"])
        self.assertIn('data-fig-id="r.group.color.0.1"', baseline["svg"])

        patched_a = _object(patched, "r.group.color.0.0")
        patched_b = _object(patched, "r.group.color.0.1")
        self.assertEqual(patched_a["currentProps"]["color"], group_a["currentProps"]["color"])
        self.assertEqual(patched_b["currentProps"]["color"], "#2CA02C")
        self.assertEqual(patched_b["identity"]["semanticKey"], group_b["identity"]["semanticKey"])
        self.assertIn("#2CA02C".lower(), patched["svg"].lower())

        layer_relation = _object(baseline, "r.layer.0")["identity"]["relation"]
        self.assertEqual(
            layer_relation["groupIds"],
            ["r.group.color.0.0", "r.group.color.0.1"],
        )
        self.assertEqual(layer_relation["subplotIds"], ["subplot.0", "subplot.1"])

    def test_multi_panel_line_and_point_layers_keep_plural_subplot_identity(self):
        script = """
library(ggplot2)
df <- data.frame(
  x = rep(1:3, 4),
  y = c(1.0, 1.6, 2.1, 1.2, 1.8, 2.4, 0.8, 1.4, 1.9, 1.0, 1.5, 2.2),
  group = rep(c("CK", "TR"), each = 6),
  panel = rep(c("Site A", "Site B"), each = 3, times = 2)
)
p <- ggplot(df, aes(x, y, color = group, group = group)) +
  geom_line(linewidth = 0.9) +
  geom_point(size = 2.8) +
  facet_wrap(~panel, nrow = 1) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertEqual(result["status"], "success", result)
        for layer_id in ["r.layer.0", "r.layer.1"]:
            relation = _object(result, layer_id)["identity"]["relation"]
            self.assertNotIn("subplotId", relation)
            self.assertEqual(relation["subplotIds"], ["subplot.0", "subplot.1"])

    def test_duplicate_discrete_colors_do_not_guess_svg_group_identity(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#777777", B="#777777")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        group_a = _object(result, "r.group.color.0.0")
        group_b = _object(result, "r.group.color.0.1")
        self.assertFalse(group_a["currentProps"]["svgSelectable"])
        self.assertFalse(group_b["currentProps"]["svgSelectable"])
        self.assertNotIn('data-fig-id="r.group.color.0.0"', result["svg"])
        self.assertNotIn('data-fig-id="r.group.color.0.1"', result["svg"])
        self.assertIn('data-fig-id="r.layer.0"', result["svg"])

    def test_discrete_group_patch_preserves_scale_order_labels_and_title(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "B", "A", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=4) +
  scale_color_discrete(
    limits=c("B", "A"),
    breaks=c("B", "A"),
    labels=c(B="Beta", A="Alpha"),
    name="Study group",
    na.value="#123456",
    drop=FALSE
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.group.color.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        baseline_groups = baseline["manifest"]["groups"]
        patched_groups = patched["manifest"]["groups"]
        self.assertEqual([group["label"] for group in baseline_groups], ["Beta", "Alpha"])
        self.assertEqual([group["label"] for group in patched_groups], ["Beta", "Alpha"])
        self.assertEqual(_object(patched, "legend.0")["currentProps"]["title"], "Study group")
        self.assertEqual(_object(patched, "r.group.color.0.0")["currentProps"]["groupKey"], "B")
        self.assertEqual(_object(patched, "r.group.color.0.0")["currentProps"]["color"], "#2CA02C")

    def test_legend_title_and_item_text_manifest(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1,4,2,6,3,7), group=rep(c("A","B"),3))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "legend_title.0", "prop": "text", "value": "Updated group", "mode": "backend_patch"},
            {"gid": "legend_title.0", "prop": "fontsize", "value": 14, "mode": "backend_patch"},
            {"gid": "legend_title.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "text", "value": "Alpha group", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "fontsize", "value": 11, "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "legend_text.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        legend_title = _object(result, "legend_title.0")
        legend_text = _object(result, "legend_text.0.0")
        legend = _object(result, "legend.0")

        self.assertEqual(legend["currentProps"]["title"], "Updated group")
        self.assertEqual(legend_title["currentProps"]["text"], "Updated group")
        self.assertEqual(legend_title["currentProps"]["fontsize"], 14)
        self.assertEqual(legend_title["currentProps"]["color"], "#AA0000")
        self.assertEqual(legend_text["kind"], "text")
        self.assertEqual(legend_text["role"], "legend_text")
        self.assertEqual(legend_text["currentProps"]["text"], "Alpha group")
        self.assertEqual(legend_text["currentProps"]["fontsize"], 11)
        self.assertEqual(legend_text["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(legend_text["currentProps"]["color"], "#2CA02C")
        self.assertIn("text", legend_text["editable"])
        self.assertIn("Updated group", result["svg"])
        self.assertIn("Alpha group", result["svg"])

    def test_legend_internal_layout_manifest_and_patch_round_trip(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1,4,2,6,3,7), group=rep(c("A","B"),3))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_legend = _object(baseline, "legend.0")
        layout_props = ["handletextpad", "labelspacing", "columnspacing", "borderpad"]
        for prop in layout_props:
            self.assertIn(prop, baseline_legend["editable"])
            self.assertIn(prop, baseline_legend["currentProps"])
            capability = next(
                item for item in baseline_legend["propertyCapabilities"]
                if item["prop"] == prop
            )
            self.assertEqual(capability["patchMode"], "backend_patch")
            self.assertEqual(capability["replay"], "stable")

        result = _run_r_renderer(script, [
            {"gid": "legend.0", "prop": "fontsize", "value": 18, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "ncol", "value": 2, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "markerscale", "value": 2.4, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "handletextpad", "value": 1.6, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "labelspacing", "value": 1.2, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "columnspacing", "value": 2.8, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "borderpad", "value": 0.9, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "loc", "value": "bottom", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "facecolor", "value": "#F0F0F0", "mode": "backend_patch"},
        ])
        legend = _object(result, "legend.0")

        self.assertEqual(legend["currentProps"]["fontsize"], 18)
        self.assertEqual(legend["currentProps"]["ncol"], 2)
        self.assertEqual(legend["currentProps"]["markerscale"], 2.4)
        self.assertEqual(legend["currentProps"]["handletextpad"], 1.6)
        self.assertEqual(legend["currentProps"]["labelspacing"], 1.2)
        self.assertEqual(legend["currentProps"]["columnspacing"], 2.8)
        self.assertEqual(legend["currentProps"]["borderpad"], 0.9)
        self.assertEqual(legend["currentProps"]["loc"], "bottom")
        self.assertIn("#f0f0f0", result["svg"].lower())

    def test_boxplot_and_violin_layers_are_semantic_containers(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1:10, 3:12))
p <- ggplot(df, aes(group, value, fill=group)) +
  geom_boxplot(alpha=0.7) +
  geom_violin(alpha=0.3) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "box_color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "median_color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "facecolor", "value": "#9467BD", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "edgecolor", "value": "#111111", "mode": "backend_patch"},
        ])
        box = _object(result, "r.layer.0")
        violin = _object(result, "r.layer.1")

        self.assertEqual(box["kind"], "boxplot_container")
        self.assertIn("box_color", box["editable"])
        self.assertIn("median_color", box["editable"])
        self.assertEqual(box["currentProps"]["box_color"], "#2CA02C")
        self.assertEqual(box["currentProps"]["median_color"], "#AA0000")
        self.assertEqual(box["currentProps"]["linewidth"], 2)
        self.assertEqual(violin["kind"], "violinplot_container")
        self.assertIn("facecolor", violin["editable"])
        self.assertEqual(violin["currentProps"]["facecolor"], "#9467BD")
        self.assertEqual(violin["currentProps"]["edgecolor"], "#111111")

    def test_facet_manifest_and_strip_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:8, y=1:8, facet=rep(c("F1","F2"), each=4))
p <- ggplot(df, aes(x,y)) + geom_point() + facet_wrap(~facet) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "facet.strip.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "facet.strip.0", "prop": "fontsize", "value": 16, "mode": "backend_patch"},
            {"gid": "subplot.1", "prop": "aspect", "value": "1", "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)
        self.assertIn("aspect", subplots[0]["editable"])
        self.assertEqual(subplots[0]["currentProps"]["aspect"], 1)
        self.assertEqual(subplots[1]["currentProps"]["aspect"], 1)
        aspect_capability = next(
            capability for capability in subplots[0]["propertyCapabilities"]
            if capability["prop"] == "aspect"
        )
        self.assertEqual(aspect_capability["coordinateSpace"], "container")
        self.assertEqual(aspect_capability["scopes"], ["figure"])
        self.assertIn("left", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("width", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "facet.strip.0")["currentProps"]["fontsize"], 16)

    def test_facet_non_first_panel_tick_edits_apply_to_global_axis_theme(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(c("A", "B", "C"), 2),
  y=c(1, 3, 2, 2, 4, 3),
  facet=rep(c("F1","F2"), each=3)
)
p <- ggplot(df, aes(x,y)) + geom_col() + facet_wrap(~facet) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "xtick.1.0", "prop": "fontsize", "value": 15, "mode": "backend_patch"},
            {"gid": "xtick.1.0", "prop": "fontfamily", "value": "Times New Roman", "mode": "backend_patch"},
            {"gid": "xtick.1.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "axis.x.1", "prop": "tick_rotation", "value": 30, "mode": "backend_patch"},
            {"gid": "axis.x.1", "prop": "tick_direction", "value": "in", "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)

        xtick = _object(result, "xtick.1.0")
        axis_x = _object(result, "axis.x.0")
        self.assertEqual(xtick["currentProps"]["fontsize"], 15)
        self.assertEqual(xtick["currentProps"]["fontfamily"], "Times New Roman")
        self.assertEqual(xtick["currentProps"]["color"], "#AA0000")
        # ggplot applies facet tick styling through the global axis theme.
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 15)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "Times New Roman")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "#AA0000")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 30)
        self.assertEqual(axis_x["currentProps"]["tick_direction"], "in")

    def test_heatmap_colorbar_patch(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:4, y=1:3)
df$z <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x, y, fill=z)) +
  geom_tile() +
  scale_fill_gradient(low="#132B43", high="#56B1F7", limits=c(0, 2), name="Intensity") +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.heatmap.fill.0", "prop": "cmap", "value": "inferno", "mode": "backend_patch"},
            {"gid": "r.heatmap.fill.0", "prop": "vmin", "value": 0.2, "mode": "backend_patch"},
            {"gid": "r.heatmap.fill.0", "prop": "vmax", "value": 1.1, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "label", "value": "Updated intensity", "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "tick_fontsize", "value": 15, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "left", "value": 0.72, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "bottom", "value": 0.18, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "width", "value": 0.08, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "height", "value": 0.45, "mode": "backend_patch"},
        ])
        heatmaps = [obj for obj in _objects(result) if obj["kind"] == "heatmap"]
        colorbars = [obj for obj in _objects(result) if obj["kind"] == "colorbar"]
        self.assertEqual(len(heatmaps), 1)
        self.assertEqual(len(colorbars), 1)
        self.assertIn("Updated intensity", result["svg"])
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["cmap"], "inferno")
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["vmin"], 0.2)
        colorbar = _object(result, "r.colorbar.fill.0")
        self.assertEqual(colorbar["currentProps"]["tick_fontsize"], 15)
        heatmap = _object(result, "r.heatmap.fill.0")
        self.assertEqual(heatmap["identity"]["relation"]["colorbarId"], colorbar["id"])
        self.assertEqual(colorbar["identity"]["relation"]["mappableId"], heatmap["id"])
        self.assertEqual(colorbar["identity"]["relation"]["mappableIds"], [heatmap["id"]])
        self.assertEqual(heatmap["identity"]["relation"]["layerIds"], ["r.layer.0"])
        self.assertEqual(colorbar["identity"]["relation"]["layerIds"], ["r.layer.0"])
        self.assertEqual(heatmap["identity"]["relation"]["subplotIds"], ["subplot.0"])
        self.assertEqual(colorbar["identity"]["relation"]["subplotIds"], ["subplot.0"])
        self.assertEqual(heatmap["identity"]["relation"]["scaleId"], "r.scale.fill.continuous.0")
        self.assertEqual(colorbar["identity"]["relation"]["scaleId"], "r.scale.fill.continuous.0")
        self.assertEqual(heatmap["identity"]["relation"]["guideId"], colorbar["id"])
        self.assertIn("left", colorbar["editable"])
        self.assertIn("bottom", colorbar["editable"])
        self.assertIn("width", colorbar["editable"])
        self.assertIn("height", colorbar["editable"])
        self.assertEqual(colorbar["currentProps"]["left"], 0.72)
        self.assertEqual(colorbar["currentProps"]["bottom"], 0.18)
        self.assertEqual(colorbar["currentProps"]["width"], 0.08)
        self.assertEqual(colorbar["currentProps"]["height"], 0.45)
        colorbar_capabilities = {
            capability["prop"]: capability
            for capability in colorbar["propertyCapabilities"]
        }
        for prop in ("left", "bottom", "width", "height"):
            self.assertEqual(colorbar_capabilities[prop]["coordinateSpace"], "figure")

    def test_continuous_point_fill_exposes_restorable_colorbar_alignment(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(2, 4, 3, 6, 5, 7), value=seq(0, 1, length.out=6))
p <- ggplot(df, aes(x, y, fill=value)) +
  geom_point(shape=21, size=5, colour="white") +
  scale_fill_gradientn(
    colours=c("#F23B20", "#FFD54A", "#43C6B7", "#6548D8"),
    limits=c(0, 1), breaks=c(0, 0.5, 1), name="Continuous points"
  ) +
  theme_classic() +
  theme(legend.position="right")
p
"""
        baseline = _run_r_renderer(script)
        self.assertEqual(len([obj for obj in _objects(baseline) if obj["kind"] == "heatmap"]), 0)
        colorbar = _object(baseline, "r.colorbar.fill.0")
        subplot = _object(baseline, "subplot.0")
        self.assertEqual(colorbar["identity"]["relation"]["mappableId"], "r.layer.0")
        self.assertEqual(colorbar["identity"]["relation"]["subplotIds"], ["subplot.0"])
        for prop in ("left", "bottom", "width", "height"):
            self.assertGreater(float(colorbar["currentProps"][prop]), 0)
            self.assertGreater(float(subplot["currentProps"][prop]), 0)

        edits = [
            {"gid": "r.colorbar.fill.0", "prop": "left", "value": 0.751, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "bottom", "value": 0.2345, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "width", "value": 0.024, "mode": "backend_patch"},
            {"gid": "r.colorbar.fill.0", "prop": "height", "value": 0.6244, "mode": "backend_patch"},
        ]
        patched = _run_r_renderer(script, edits)
        self.assertNotEqual(baseline["svg"], patched["svg"])
        patched_colorbar = _object(patched, "r.colorbar.fill.0")
        for edit in edits:
            self.assertAlmostEqual(patched_colorbar["currentProps"][edit["prop"]], edit["value"])
        self.assertIn("Continuous points", patched["svg"])
        self.assertIn(">0.0<", patched["svg"])
        self.assertIn(">0.5<", patched["svg"])
        self.assertIn(">1.0<", patched["svg"])

    def test_text_annotation_position_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y)) +
  geom_point() +
  geom_text(aes(label=label), color="#D62728", size=4) +
  annotate("text", x=2, y=4.5, label="Note", color="#1F78B4", size=5) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.1.0", "prop": "text", "value": "Alpha", "mode": "backend_patch"},
            {"gid": "r.text.1.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.text.1.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_objects = [obj for obj in _objects(result) if obj["id"].startswith("r.text.")]
        self.assertEqual(len(text_objects), 4)
        text_obj = _object(result, "r.text.1.0")
        self.assertIn('id="r.text.1.0"', result["svg"])
        self.assertIn('id="r.text.2.0"', result["svg"])
        self.assertIn("Alpha", result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(text_obj["currentProps"]["text"], "Alpha")
        self.assertEqual(text_obj["currentProps"]["x"], 0.8)
        self.assertEqual(text_obj["currentProps"]["y"], 0.2)
        self.assertEqual(text_obj["currentProps"]["coord_system"], "axes")
        self.assertEqual(text_obj["identity"]["relation"]["annotationId"], text_obj["id"])
        self.assertEqual(text_obj["identity"]["relation"]["layerId"], "r.layer.1")
        self.assertEqual(text_obj["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertEqual(text_obj["identity"]["relation"]["aesthetic"], "label")
        self.assertNotIn("arrowId", text_obj["identity"]["relation"])
        self.assertEqual(text_obj["currentProps"]["identityStability"], "stable")
        self.assertTrue(all(
            capability["replay"] == ("conditional" if capability["prop"] == "position" else "stable")
            for capability in text_obj["propertyCapabilities"]
        ))
        self.assertGreater(text_obj["currentProps"]["data_x"], 1)
        self.assertLess(text_obj["currentProps"]["data_y"], 4)

    def test_text_data_key_survives_code_row_reordering(self):
        baseline_script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b", "sample-c"),
  x=1:3,
  y=c(2,4,3),
  label=c("A","B","C")
)
p <- ggplot(df, aes(x,y,label=label)) + geom_text() + theme_classic()
p
"""
        reordered_script = baseline_script.replace(
            'p <- ggplot(df, aes(x,y,label=label))',
            'df <- df[c(3,1,2),]\np <- ggplot(df, aes(x,y,label=label))',
        )
        baseline = _run_r_renderer(baseline_script)
        sample_a = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("dataKey") == "sample-a"
        )
        result = _run_r_renderer(reordered_script, [
            {"gid": sample_a["id"], "prop": "text", "value": "Alpha", "mode": "backend_patch"},
            {"gid": sample_a["id"], "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        reordered_a = _object(result, sample_a["id"])
        sample_b = next(
            obj for obj in _objects(result)
            if obj.get("currentProps", {}).get("dataKey") == "sample-b"
        )

        self.assertEqual(reordered_a["currentProps"]["text"], "Alpha")
        self.assertEqual(reordered_a["currentProps"]["color"], "#2CA02C")
        self.assertEqual(reordered_a["currentProps"]["identityStability"], "stable")
        self.assertEqual(reordered_a["identity"]["instanceKey"], sample_a["identity"]["instanceKey"])
        self.assertEqual(reordered_a["identity"]["semanticKey"], sample_a["identity"]["semanticKey"])
        self.assertEqual(reordered_a["identity"]["relation"]["dataKey"], "sample-a")
        self.assertEqual(sample_b["currentProps"]["text"], "B")
        text_capability = next(
            capability for capability in reordered_a["propertyCapabilities"]
            if capability["prop"] == "text"
        )
        self.assertEqual(text_capability["replay"], "stable")

    def test_text_position_supported_for_coord_flip(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text(color="#D62728", size=4) +
  coord_flip() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
            {"gid": "r.text.0.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn('id="r.text.0.0"', result["svg"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.8, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.2, places=5)
        self.assertNotIn("positionEditable", text_obj["currentProps"])
        self.assertFalse(any("CoordFlip" in warning for warning in result.get("warnings", [])))

    def test_text_position_supported_for_x_log_scale(self):
        script = """
library(ggplot2)
df <- data.frame(x=c(1, 10, 100), y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text(color="#D62728", size=4) +
  scale_x_log10() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.7, "y": 0.3, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.7, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.3, places=5)
        self.assertGreater(text_obj["currentProps"]["data_x"], 10)
        self.assertAlmostEqual(_object(result, "r.text.0.1")["currentProps"]["data_x"], 10, places=5)
        self.assertAlmostEqual(_object(result, "r.text.0.2")["currentProps"]["data_x"], 100, places=5)
        self.assertFalse(any("scale" in warning for warning in result.get("warnings", [])))

    def test_text_position_supported_for_y_log_scale(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(1, 10, 100), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text() +
  scale_y_log10() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.8, "y": 0.2, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.8, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.2, places=5)
        self.assertGreater(text_obj["currentProps"]["data_y"], 1)

    def test_text_position_supported_inside_coord_polar_panel(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) +
  geom_text() +
  coord_polar() +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.7, "y": 0.3, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        text_obj = _object(result, "r.text.0.0")
        self.assertIn("position", text_obj["editable"])
        self.assertAlmostEqual(text_obj["currentProps"]["x"], 0.7, places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], 0.3, places=5)

    def test_text_position_outside_coord_polar_panel_is_rejected(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2,4,3), label=c("A","B","C"))
p <- ggplot(df, aes(x,y,label=label)) + geom_text() + coord_polar() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        result = _run_r_renderer(script, [
            {"gid": "r.text.0.0", "prop": "position", "value": {"x": 0.99, "y": 0.99, "coord_system": "axes"}, "mode": "backend_patch"},
        ])
        baseline_text = _object(baseline, "r.text.0.0")
        text_obj = _object(result, "r.text.0.0")
        self.assertAlmostEqual(text_obj["currentProps"]["x"], baseline_text["currentProps"]["x"], places=5)
        self.assertAlmostEqual(text_obj["currentProps"]["y"], baseline_text["currentProps"]["y"], places=5)
        self.assertTrue(any("could not be inverted" in warning for warning in result.get("warnings", [])))

    def test_base_r_output_is_explicitly_unsupported_for_semantic_editing(self):
        result = _run_r_renderer('plot(1:3, 1:3, main="Base R preview")')
        report = result["manifest"]["coverageReport"]
        self.assertEqual(result["manifest"]["objects"], [])
        self.assertEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(report["unsupportedArtists"][0]["class"], "base_r_or_grid_output")
        self.assertFalse(result["manifest"]["capabilities"]["backendPatch"])
        self.assertIn("Base R preview", result["svg"])

    def test_unknown_ggplot_geom_is_readonly_and_explicitly_unsupported(self):
        script = """
library(ggplot2)
GeomCustomPoint <- ggproto("GeomCustomPoint", GeomPoint)
geom_custom_point <- function(mapping=NULL, data=NULL, ...) {
  layer(
    geom=GeomCustomPoint,
    mapping=mapping,
    data=data,
    stat="identity",
    position="identity",
    inherit.aes=TRUE,
    params=list(...)
  )
}
df <- data.frame(x=1:3, y=c(2,4,3))
p <- ggplot(df, aes(x,y)) + geom_custom_point(size=4) + theme_classic()
p
"""
        result = _run_r_renderer(script)
        layer = _object(result, "r.layer.0")
        report = result["manifest"]["coverageReport"]
        self.assertEqual(layer["kind"], "unsupported")
        self.assertEqual(layer["editable"], [])
        self.assertIn("GeomCustomPoint", layer["currentProps"]["unsupportedReason"])
        self.assertEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(report["unsupportedArtists"][0]["class"], "GeomCustomPoint")
        self.assertTrue(result["svg"])

    def test_renamed_multi_scale_aesthetic_is_reported_without_unsafe_merge(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x,y,color=group)) +
  geom_point(size=4) +
  scale_color_discrete() +
  theme_classic()
p$scales$scales[[1]]$aesthetics <- "colour_ggnewscale_1"
p
"""
        result = _run_r_renderer(script)
        report = result["manifest"]["coverageReport"]
        extension = next(
            item for item in report["unsupportedArtists"]
            if item["class"] == "ggnewscale_or_renamed_aesthetic"
        )
        self.assertGreaterEqual(report["summary"]["unsupported"], 1)
        self.assertEqual(extension["count"], 1)
        self.assertTrue(result["svg"])

    def assert_delimited_sidecar_bridge(self, logical_name: str, mapped_name: str, reader_call: str):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar_name = f"{mapped_name}.scifigure-table.json"
            sidecar_path = os.path.join(tmp, sidecar_name)
            with open(sidecar_path, "w", encoding="utf-8") as f:
                json.dump({
                    "columns": ["样本名称", "浓度（µg/L）", "备注"],
                    "rows": [
                        {"样本名称": "alpha,beta", "浓度（µg/L）": 1.5, "备注": "含逗号,应保留"},
                        {"样本名称": "gamma,delta", "浓度（µg/L）": 2.5, "备注": "quoted,comma"},
                    ],
                }, f, ensure_ascii=False)
            script = f"""
library(ggplot2)
stopifnot(
  length(uploaded_file_paths) == 1L,
  identical(names(uploaded_file_paths), "{logical_name}"),
  identical(as.character(uploaded_file_paths[["{logical_name}"]]), "{mapped_name}")
)
df <- {reader_call}
unit_header <- paste0("浓度（", intToUtf8(181L), "g/L）")
stopifnot(
  identical(names(df), c("样本名称", unit_header, "备注")),
  identical(as.character(df[["样本名称"]]), c("alpha,beta", "gamma,delta")),
  isTRUE(all.equal(as.numeric(df[[unit_header]]), c(1.5, 2.5))),
  identical(as.character(df[["备注"]]), c("含逗号,应保留", "quoted,comma"))
)
plot_df <- data.frame(sample_name = df[["样本名称"]], concentration = df[[unit_header]])
p <- ggplot(plot_df, aes(x = sample_name, y = concentration)) +
  geom_col() +
  labs(x = "样本名称", y = unit_header) +
  theme_classic()
p
"""
            result = _run_r_renderer(script, extra_payload={
                "cwd": tmp,
                "uploaded_file_paths": {logical_name: mapped_name},
                "csv_json_paths": {mapped_name: sidecar_name},
            })
            self.assertEqual(result["status"], "success")
            self.assertIn("alpha,beta", result["svg"])

    def test_uploaded_csv_sidecar_preserves_quoted_commas_unicode_headers_and_path_map(self):
        self.assert_delimited_sidecar_bridge(
            "analysis.csv",
            "mirrored-analysis.csv",
            'read.csv(uploaded_file_paths[["analysis.csv"]], check.names = FALSE)',
        )

    def test_uploaded_tsv_sidecar_preserves_quoted_commas_unicode_headers_and_path_map(self):
        self.assert_delimited_sidecar_bridge(
            "analysis.tsv",
            "mirrored-analysis.tsv",
            'read.table(uploaded_file_paths[["analysis.tsv"]], header = TRUE, sep = "\\t", check.names = FALSE)',
        )

    def test_aligned_theme_details_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            # Ticks/Axes limits/rotation/direction/width/color/pad
            {"gid": "axis.x.0", "prop": "tick_rotation", "value": 45, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_direction", "value": "in", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_length", "value": 8.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_width", "value": 2.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_color", "value": "#FF0000", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_pad", "value": 10.0, "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "limits", "value": [0, 10], "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_fontweight", "value": "bold", "mode": "backend_patch"},
            {"gid": "axis.x.0", "prop": "tick_fontstyle", "value": "italic", "mode": "backend_patch"},

            # Legend visible/loc/facecolor/edgecolor/linewidth
            {"gid": "legend.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "loc", "value": "bottom", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "ncol", "value": 2, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "markerscale", "value": 1.8, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "facecolor", "value": "#00FF00", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "edgecolor", "value": "#0000FF", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "linewidth", "value": 1.5, "mode": "backend_patch"},

            # Spine visibility/color/linewidth
            {"gid": "spine.bottom.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "spine.bottom.0", "prop": "color", "value": "#FF00FF", "mode": "backend_patch"},
            {"gid": "spine.bottom.0", "prop": "linewidth", "value": 2.5, "mode": "backend_patch"},

            # Grid visibility/color/linewidth/linestyle
            {"gid": "grid.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "color", "value": "#FFFF00", "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "linewidth", "value": 1.2, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "linestyle", "value": "dashed", "mode": "backend_patch"},
        ])
        
        # Verify currentProps in manifest
        axis_x = _object(result, "axis.x.0")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 45)
        self.assertEqual(axis_x["currentProps"]["tick_direction"], "in")
        self.assertEqual(axis_x["currentProps"]["tick_length"], 8.0)
        self.assertEqual(axis_x["currentProps"]["tick_width"], 2.0)
        self.assertEqual(axis_x["currentProps"]["tick_color"], "#FF0000")
        self.assertEqual(axis_x["currentProps"]["tick_pad"], 10.0)
        self.assertEqual(axis_x["currentProps"]["limits"], [0, 10])
        self.assertEqual(axis_x["currentProps"]["tick_fontweight"], "bold")
        self.assertEqual(axis_x["currentProps"]["tick_fontstyle"], "italic")

        legend = _object(result, "legend.0")
        self.assertEqual(legend["currentProps"]["visible"], True)
        self.assertEqual(legend["currentProps"]["loc"], "bottom")
        self.assertEqual(legend["currentProps"]["ncol"], 2)
        self.assertEqual(legend["currentProps"]["markerscale"], 1.8)
        self.assertEqual(legend["currentProps"]["facecolor"], "#00FF00")
        self.assertEqual(legend["currentProps"]["edgecolor"], "#0000FF")
        self.assertEqual(legend["currentProps"]["linewidth"], 1.5)

        spine_b = _object(result, "spine.bottom.0")
        self.assertEqual(spine_b["currentProps"]["visible"], True)
        self.assertEqual(spine_b["currentProps"]["color"], "#FF00FF")
        self.assertEqual(spine_b["currentProps"]["linewidth"], 2.5)

        grid = _object(result, "grid.0")
        self.assertEqual(grid["currentProps"]["visible"], True)
        self.assertEqual(grid["currentProps"]["color"], "#FFFF00")
        self.assertEqual(grid["currentProps"]["linewidth"], 1.2)
        self.assertEqual(grid["currentProps"]["linestyle"], "dashed")

    def test_r_axis_manifest_reports_initial_limits(self):
        script = """
library(ggplot2)
df <- data.frame(x=c(2, 4, 8), y=c(10, 20, 40))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
"""
        result = _run_r_renderer(script)
        x_limits = _object(result, "axis.x.0")["currentProps"]["limits"]
        y_limits = _object(result, "axis.y.0")["currentProps"]["limits"]

        self.assertIsInstance(x_limits, list)
        self.assertIsInstance(y_limits, list)
        self.assertEqual(len(x_limits), 2)
        self.assertEqual(len(y_limits), 2)
        self.assertLessEqual(x_limits[0], 2)
        self.assertGreaterEqual(x_limits[1], 8)
        self.assertLessEqual(y_limits[0], 10)
        self.assertGreaterEqual(y_limits[1], 40)

    def test_r_grid_and_legend_alpha_patch_changes_svg_output(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) +
  geom_point(size=3) +
  theme_bw()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "grid.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "color", "value": "#FF0000", "mode": "backend_patch"},
            {"gid": "grid.0", "prop": "alpha", "value": 0.25, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "visible", "value": True, "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "facecolor", "value": "#00FF00", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "edgecolor", "value": "#0000FF", "mode": "backend_patch"},
            {"gid": "legend.0", "prop": "alpha", "value": 0.35, "mode": "backend_patch"},
        ])
        svg = result["svg"].lower()
        self.assertIn("#ff0000", svg)
        self.assertIn("#00ff00", svg)
        self.assertIn("#0000ff", svg)
        self.assertTrue("stroke-opacity: 0.25" in svg or "stroke-opacity=\"0.25\"" in svg)
        self.assertTrue("fill-opacity: 0.35" in svg or "fill-opacity=\"0.35\"" in svg)

    def test_r_renderer_reports_monotonic_timing_breakdown(self):
        result = _run_r_renderer("""
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point() + theme_classic()
p
""")
        self.assertEqual(result.get("status"), "success")
        timing = result.get("timingBreakdown", {})
        expected_keys = {
            "scriptExecutionMs",
            "svgSerializeMs",
            "manifestBuildMs",
            "svgPostprocessMs",
            "totalMs",
        }
        self.assertTrue(expected_keys.issubset(timing.keys()))
        self.assertTrue(all(isinstance(timing[key], (int, float)) and timing[key] >= 0 for key in expected_keys))
        self.assertEqual(result["timingMs"], timing["totalMs"])
        self.assertGreaterEqual(timing["totalMs"], timing["svgSerializeMs"])

    def test_r_renderer_returns_runtime_inventory_contract(self):
        result = _run_r_renderer("""
library(ggplot2)
df <- data.frame(x=1:3, y=c(1, 2, 1))
p <- ggplot(df, aes(x, y)) + geom_line()
p
""")
        inventory = result.get("runtimeInventory")
        self.assertIsInstance(inventory, dict)
        self.assertEqual(inventory.get("schemaVersion"), "1.0")
        self.assertTrue(inventory.get("executable", {}).get("rscript"))
        self.assertTrue(inventory.get("r", {}).get("version"))
        self.assertTrue(inventory.get("r", {}).get("platform"))
        self.assertTrue(inventory.get("r", {}).get("home"))
        self.assertTrue(inventory.get("libraryPaths"))
        self.assertTrue(inventory.get("workingDirectory"))
        self.assertTrue(inventory.get("temporaryDirectory"))
        self.assertIn("locale", inventory)
        self.assertIn("timezone", inventory)
        self.assertIn("graphics", inventory)
        self.assertIn("fonts", inventory)
        packages = inventory.get("packages", {})
        self.assertTrue(packages.get("jsonlite", {}).get("installed"))
        self.assertTrue(packages.get("ggplot2", {}).get("installed"))
        self.assertIn("textshaping", packages)
        self.assertIn("FreeSans", inventory.get("fonts", {}).get("candidates", {}))
        self.assertEqual(inventory.get("locale", {}).get("categories", {}).get("LC_COLLATE"), "C")
        self.assertTrue(inventory.get("checks", {}).get("ok"))


if __name__ == "__main__":
    unittest.main()

import base64
import hashlib
import json
import os
import re
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


def _legacy_text_role_patch(obj: Dict[str, Any], prop: str, value: Any) -> Dict[str, Any]:
    payload = _decode_r_v2_fingerprint(obj["fingerprint"])
    payload["role"] = "ggplot_text_annotation"
    fingerprint = "r-v2:" + base64.b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    identity = json.loads(json.dumps(obj["identity"], ensure_ascii=False))
    relation = identity.setdefault("relation", {})
    relation.pop("textSource", None)
    relation.pop("statClass", None)
    relation["annotationId"] = obj["id"]
    return {
        "gid": obj["id"],
        "prop": prop,
        "value": value,
        "mode": "backend_patch",
        "stableKey": obj["stableKey"],
        "fingerprint": fingerprint,
        "fingerprintVersion": 2,
        "identity": identity,
    }


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

    def test_v2_data_text_replays_pre_role_split_identity(self):
        script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b"),
  x=c(1, 2), y=c(2, 3), label=c("Alpha", "Beta")
)
p <- ggplot(df, aes(x, y, label=label)) + geom_text() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("role") == "ggplot_text_data"
            and obj.get("identity", {}).get("relation", {}).get("dataKey") == "sample-a"
        )
        legacy_patch = _legacy_text_role_patch(target, "color", "#2CA02C")

        replayed = _run_r_renderer(script, [legacy_patch])
        replayed_target = _object(replayed, target["id"])

        self.assertFalse(replayed["conflict"])
        self.assertEqual(replayed["skipped"], [])
        self.assertEqual(replayed_target["role"], "ggplot_text_data")
        self.assertEqual(replayed_target["currentProps"]["color"], "#2CA02C")


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

    def test_v2_identity_does_not_remap_from_an_unrelated_missing_gid_family(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x, y, color=group)) + geom_point(size=3) + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        target = _object(baseline, "r.group.color.0.0")
        patch = _backend_patch(target, "color", "#2CA02C")
        patch["gid"] = "r.group.color.99.99"

        rejected = _run_r_renderer(script, [patch])
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(rejected["skipped"], [patch])
        self.assertTrue(any(
            warning.get("type") == "identity_mismatch"
            and warning.get("gid") == patch["gid"]
            for warning in rejected["warnings"]
            if isinstance(warning, dict)
        ))

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
            (_object(baseline, "r.facet.layout.0"), "aspect", 1.2),
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
        target = next(obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_data")
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
        target = next(obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_data")

        replayed = _run_r_renderer(drifted_script, [
            _backend_patch(target, "color", "#CC0000"),
        ])

        self.assertTrue(replayed["conflict"])
        self.assertEqual(replayed["applied"], [])
        self.assertEqual(len(replayed["skipped"]), 1)
        self.assertNotEqual(
            next(obj for obj in _objects(replayed) if obj.get("role") == "ggplot_text_data")["currentProps"]["color"],
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
        targets = [obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_data"]
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
        same_script_replay = _run_r_renderer(color_first, [patch])
        self.assertFalse(same_script_replay["conflict"])
        same_script_target = _object(same_script_replay, target["id"])
        self.assertEqual(same_script_target["stableKey"], target["stableKey"])
        self.assertEqual(same_script_target["currentProps"]["text"], "Treatment A")

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

        legend_titles = [obj for obj in _objects(result) if obj.get("role") == "legend_title"]
        guides = [obj for obj in _objects(result) if obj.get("role") == "ggplot_semantic_guide"]
        self.assertEqual({obj["currentProps"]["text"] for obj in legend_titles}, {"Outline group", "Fill group"})
        self.assertEqual(len(guides), 2)
        title_by_id = {obj["id"]: obj for obj in legend_titles}
        for guide in guides:
            relation = guide["identity"]["relation"]
            title = title_by_id[relation["legendTitleId"]]
            self.assertEqual(title["identity"]["relation"]["guideKey"], relation["guideKey"])

        target = next(obj for obj in legend_titles if obj["currentProps"]["text"] == "Outline group")
        target_guide = next(
            guide for guide in guides
            if guide["identity"]["relation"]["legendTitleId"] == target["id"]
        )
        reordered_script = script.replace(
            'scale_color_manual(values=c(A="#111111", B="#222222"), name="Outline group") +\n  '
            'scale_fill_manual(values=c(A="#AAAAAA", B="#BBBBBB"), name="Fill group")',
            'scale_fill_manual(values=c(A="#AAAAAA", B="#BBBBBB"), name="Fill group") +\n  '
            'scale_color_manual(values=c(A="#111111", B="#222222"), name="Outline group")',
        )
        replayed = _run_r_renderer(reordered_script, [
            _backend_patch(target, "text", "A outline"),
            _backend_patch(target, "fontsize", 17),
            _backend_patch(target, "color", "#123456"),
        ])
        replayed_titles = [obj for obj in _objects(replayed) if obj.get("role") == "legend_title"]
        self.assertFalse(replayed["conflict"])
        self.assertEqual(
            {obj["currentProps"]["text"] for obj in replayed_titles},
            {"A outline", "Fill group"},
        )
        replayed_target = next(obj for obj in replayed_titles if obj["currentProps"]["text"] == "A outline")
        replayed_target_guide = next(
            guide for guide in _objects(replayed)
            if guide.get("role") == "ggplot_semantic_guide"
            and guide["identity"]["relation"]["legendTitleId"] == replayed_target["id"]
        )
        self.assertEqual(replayed_target["id"], target["id"])
        self.assertEqual(replayed_target["stableKey"], target["stableKey"])
        self.assertEqual(replayed_target["fingerprint"], target["fingerprint"])
        self.assertEqual(replayed_target["currentProps"]["fontsize"], 17)
        self.assertEqual(replayed_target["currentProps"]["color"], "#123456")
        self.assertEqual(replayed_target_guide["id"], target_guide["id"])
        self.assertEqual(replayed_target_guide["stableKey"], target_guide["stableKey"])
        self.assertEqual(replayed_target_guide["fingerprint"], target_guide["fingerprint"])
        self.assertIn("A outline", replayed["svg"])
        self.assertIn("Fill group", replayed["svg"])
        target_tag = re.search(
            rf'<text\b(?=[^>]*\bid=["\']{re.escape(replayed_target["id"])}["\'])[^>]*>',
            replayed["svg"],
        )
        self.assertIsNotNone(target_tag)
        self.assertIn("font-size: 17pt", target_tag.group(0))
        self.assertIn("fill: #123456", target_tag.group(0))
        untouched_title = next(obj for obj in replayed_titles if obj["id"] != replayed_target["id"])
        untouched_tag = re.search(
            rf'<text\b(?=[^>]*\bid=["\']{re.escape(untouched_title["id"])}["\'])[^>]*>',
            replayed["svg"],
        )
        self.assertIsNotNone(untouched_tag)
        self.assertNotIn("font-size: 17pt", untouched_tag.group(0))
        self.assertNotIn("fill: #123456", untouched_tag.group(0))

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
        same_script = _run_r_renderer(color_first, [
            patch,
            _backend_patch(target, "fontsize", 18),
            _backend_patch(target, "color", "#654321"),
        ])
        self.assertFalse(same_script["conflict"])
        untouched_item = next(
            obj for obj in _objects(same_script)
            if obj.get("role") == "legend_text"
            and obj.get("identity", {}).get("relation", {}).get("dataKey") == "legend:fill:A"
        )
        untouched_item_tag = re.search(
            rf'<text\b(?=[^>]*\bid=["\']{re.escape(untouched_item["id"])}["\'])[^>]*>',
            same_script["svg"],
        )
        self.assertIsNotNone(untouched_item_tag)
        self.assertNotIn("font-size: 18pt", untouched_item_tag.group(0))
        self.assertNotIn("fill: #654321", untouched_item_tag.group(0))

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
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 9)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "black")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 0)
        self.assertIn("font-size: 13pt", result["svg"])
        self.assertIn("fill: #AA0000".lower(), result["svg"].lower())
        self.assertIn("tick_labelcolor", axis_x["editable"])
        self.assertIn("tick_labelcolor", axis_y["editable"])

    def test_same_numeric_x_y_tick_labels_keep_axis_specific_svg_ids(self):
        script = """
library(ggplot2)
df <- data.frame(x=0:2, y=0:2)
p <- ggplot(df, aes(x, y)) + geom_point() + scale_x_continuous(breaks=0:2) + scale_y_continuous(breaks=0:2) + theme_classic()
p
"""
        result = _run_r_renderer(script)

        xtick_tag = re.search(r'<text[^>]*id="xtick\.0\.0"[^>]*>\s*0\s*</text>', result["svg"])
        ytick_tag = re.search(r'<text[^>]*id="ytick\.0\.0"[^>]*>\s*0\s*</text>', result["svg"])
        self.assertIsNotNone(xtick_tag)
        self.assertIsNotNone(ytick_tag)
        self.assertIn("text-anchor='middle'", xtick_tag.group(0))
        self.assertIn("text-anchor='end'", ytick_tag.group(0))

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

    def test_line_path_and_smooth_adapters_replay_visual_line_style(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 3, 2, 5, 4, 6), group=rep(c("A", "B"), 3))
p <- ggplot(df, aes(x, y)) +
  geom_line(colour="#1F78B4", linewidth=0.7, linetype="dashed", alpha=0.8) +
  geom_path(aes(group=group), colour="#33A02C", linewidth=0.9) +
  geom_smooth(method="lm", se=TRUE, colour="#6A3D9A", linewidth=1.1, linetype="dotdash", alpha=0.6) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2.2, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linestyle", "value": "solid", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "alpha", "value": 0.45, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.2", "prop": "color", "value": "#FF7F0E", "mode": "backend_patch"},
        ])
        line = _object(result, "r.layer.0")
        path = _object(result, "r.layer.1")
        smooth = _object(result, "r.layer.2")

        for obj, artist_class in ((line, "GeomLine"), (path, "GeomPath"), (smooth, "GeomSmooth")):
            self.assertEqual(obj["source"]["artistClass"], artist_class)
            self.assertEqual(obj["currentProps"]["adapterFamily"], "line")
            self.assertIn("color", obj["editable"])
            self.assertIn("linewidth", obj["editable"])
            self.assertIn("linestyle", obj["editable"])
            self.assertIn("alpha", obj["editable"])
            self.assertNotIn("facecolor", obj["editable"])
        self.assertEqual(line["currentProps"]["color"], "#D62728")
        self.assertEqual(line["currentProps"]["linewidth"], 2.2)
        self.assertEqual(line["currentProps"]["linestyle"], "solid")
        self.assertEqual(line["currentProps"]["alpha"], 0.45)
        self.assertEqual(path["currentProps"]["color"], "#2CA02C")
        self.assertEqual(smooth["currentProps"]["color"], "#FF7F0E")
        self.assertTrue(smooth["currentProps"]["smoothLayer"])
        self.assertIn("#D62728".lower(), result["svg"].lower())
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertIn("#FF7F0E".lower(), result["svg"].lower())

    def test_mapped_linewidth_and_linetype_line_layer_reports_mapping_but_replays_absolute_override(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 2, 4, 3, 5, 6), group=rep(c("A", "B"), 3), weight=c(1, 2, 3, 4, 5, 6))
p <- ggplot(df, aes(x, y)) +
  geom_line(aes(linewidth=weight), colour="#1F78B4", linetype="solid") +
  geom_line(aes(linetype=group), colour="#33A02C", linewidth=0.8) +
  scale_linetype_manual(values=c(A="solid", B="dashed")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_line = _object(baseline, "r.layer.0")
        baseline_linetype = _object(baseline, "r.layer.1")
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2.4, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "linestyle", "value": "dotted", "mode": "backend_patch"},
        ])
        line = _object(result, "r.layer.0")
        linetype_line = _object(result, "r.layer.1")

        self.assertTrue(baseline_line["currentProps"]["linewidthMapped"])
        self.assertFalse(baseline_line["currentProps"]["linetypeMapped"])
        self.assertTrue(baseline_linetype["currentProps"]["linetypeMapped"])
        self.assertGreater(len(set(baseline_line["currentProps"]["linewidthValues"])), 1)
        self.assertFalse(result["conflict"])
        self.assertNotEqual(baseline["svg"], result["svg"])
        self.assertEqual(line["currentProps"]["linewidth"], 2.4)
        self.assertEqual(linetype_line["currentProps"]["linestyle"], "dotted")
        self.assertEqual(line["currentProps"]["adapterFamily"], "line")
        self.assertEqual(linetype_line["currentProps"]["adapterFamily"], "line")

    def test_inherited_plot_mapping_flags_are_reported_for_line_adapter(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 2, 4, 3, 5, 6), group=rep(c("A", "B"), 3), weight=c(1, 2, 3, 4, 5, 6))
p <- ggplot(df, aes(x, y, group=group, colour=group, linewidth=weight)) +
  geom_line() +
  scale_colour_manual(values=c(A="#1F78B4", B="#33A02C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_line = _object(baseline, "r.layer.0")
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2.1, "mode": "backend_patch"},
        ])
        line = _object(result, "r.layer.0")

        self.assertTrue(baseline_line["currentProps"]["colorMapped"])
        self.assertTrue(baseline_line["currentProps"]["linewidthMapped"])
        self.assertGreater(len(set(baseline_line["currentProps"]["linewidthValues"])), 1)
        self.assertFalse(result["conflict"])
        self.assertEqual(line["currentProps"]["color"], "#D62728")
        self.assertEqual(line["currentProps"]["linewidth"], 2.1)
        self.assertIn("#D62728".lower(), result["svg"].lower())

    def test_inherited_linetype_mapping_is_reported_for_line_adapter(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 2, 4, 3, 5, 6), group=rep(c("A", "B"), 3))
p <- ggplot(df, aes(x, y, group=group, linetype=group)) +
  geom_line(colour="#33A02C", linewidth=0.8) +
  scale_linetype_manual(values=c(A="solid", B="dashed")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "linestyle", "value": "dotted", "mode": "backend_patch"},
        ])
        baseline_line = _object(baseline, "r.layer.0")
        line = _object(result, "r.layer.0")

        self.assertTrue(baseline_line["currentProps"]["linetypeMapped"])
        self.assertFalse(result["conflict"])
        self.assertEqual(line["currentProps"]["linestyle"], "dotted")
        self.assertNotEqual(baseline["svg"], result["svg"])

    def test_inherited_plot_mapping_flags_are_reported_for_point_adapter(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=rep(c("A", "B"), 2), weight=c(1, 2, 4, 8))
p <- ggplot(df, aes(x, y, size=weight, shape=group, colour=group, fill=group)) +
  geom_point(stroke=0.8) +
  scale_shape_manual(values=c(A=21, B=22)) +
  scale_colour_manual(values=c(A="#1F78B4", B="#33A02C")) +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        layer = _object(result, "r.layer.0")

        self.assertTrue(layer["currentProps"]["sizeMapped"])
        self.assertTrue(layer["currentProps"]["shapeMapped"])
        self.assertTrue(layer["currentProps"]["colorMapped"])
        self.assertTrue(layer["currentProps"]["fillMapped"])
        self.assertTrue(layer["currentProps"]["fillSupported"])
        self.assertIn("size_scale", layer["editable"])
        self.assertIn("facecolor", layer["editable"])

    def test_line_adapter_keeps_legacy_gid_and_identity_stable_across_style_edits(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_line(colour="#1F78B4", linewidth=0.8) + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 1.9, "mode": "backend_patch"},
        ])
        baseline_line = _object(baseline, "r.layer.0")
        patched_line = _object(patched, "r.layer.0")

        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_line["stableKey"], patched_line["stableKey"])
        self.assertEqual(baseline_line["fingerprint"], patched_line["fingerprint"])
        self.assertEqual(baseline_line["identity"], patched_line["identity"])
        self.assertEqual(patched_line["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_line["currentProps"]["linewidth"], 1.9)

    def test_segment_and_curve_adapters_preserve_endpoints_and_arrow_metadata_as_readonly_structure(self):
        script = """
library(ggplot2)
library(grid)
segments <- data.frame(
  x=c(1, 2), y=c(1, 2), xend=c(2.5, 3.5), yend=c(2.2, 1.2),
  label=c("segment one", "segment two")
)
curve <- data.frame(x=1.2, y=3.2, xend=3.8, yend=3.6, label="curve label")
p <- ggplot() +
  geom_segment(
    data=segments,
    aes(x=x, y=y, xend=xend, yend=yend),
    colour="#1F78B4", linewidth=0.8, linetype="dashed", alpha=0.75,
    lineend="round", linejoin="mitre",
    arrow=arrow(length=unit(0.18, "in"), type="closed", ends="last")
  ) +
  geom_curve(
    data=curve,
    aes(x=x, y=y, xend=xend, yend=yend),
    colour="#33A02C", linewidth=1.1, curvature=0.35, angle=75, ncp=8,
    lineend="butt",
    arrow=arrow(length=unit(4, "mm"), type="open", ends="both")
  ) +
  geom_text(data=segments[1, ], aes(x=xend, y=yend, label=label), nudge_y=0.15) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        segment = _object(result, "r.layer.0")
        curve = _object(result, "r.layer.1")

        self.assertEqual(segment["kind"], "line")
        self.assertEqual(segment["role"], "ggplot_GeomSegment")
        self.assertEqual(segment["source"]["adapterClass"], "GeomSegment")
        self.assertEqual(segment["currentProps"]["adapterFamily"], "segment")
        self.assertEqual(segment["currentProps"]["x"], [1, 2])
        self.assertEqual(segment["currentProps"]["y"], [1, 2])
        self.assertEqual(segment["currentProps"]["xend"], [2.5, 3.5])
        self.assertEqual(segment["currentProps"]["yend"], [2.2, 1.2])
        self.assertEqual(segment["currentProps"]["endpointCount"], 2)
        self.assertEqual(segment["currentProps"]["lineend"], "round")
        self.assertEqual(segment["currentProps"]["linejoin"], "mitre")
        self.assertEqual(segment["currentProps"]["structureReadonly"], [
            "x", "y", "xend", "yend", "lineend", "linejoin", "arrow",
        ])
        self.assertTrue(segment["currentProps"]["hasArrow"])
        self.assertEqual(segment["currentProps"]["arrow"]["ends"], "last")
        self.assertEqual(segment["currentProps"]["arrow"]["endsCode"], 2)
        self.assertEqual(segment["currentProps"]["arrow"]["type"], "closed")
        self.assertEqual(segment["currentProps"]["arrow"]["typeCode"], 2)
        self.assertEqual(segment["currentProps"]["arrow"]["length"]["unit"], "inches")
        self.assertAlmostEqual(segment["currentProps"]["arrow"]["length"]["value"], 0.18)
        self.assertAlmostEqual(segment["currentProps"]["arrow"]["length"]["mm"], 4.572, places=3)

        self.assertEqual(curve["kind"], "line")
        self.assertEqual(curve["role"], "ggplot_GeomCurve")
        self.assertEqual(curve["source"]["adapterClass"], "GeomCurve")
        self.assertEqual(curve["currentProps"]["adapterFamily"], "curve")
        self.assertEqual(curve["currentProps"]["curvature"], 0.35)
        self.assertEqual(curve["currentProps"]["angle"], 75)
        self.assertEqual(curve["currentProps"]["ncp"], 8)
        self.assertEqual(curve["currentProps"]["lineend"], "butt")
        self.assertEqual(curve["currentProps"]["arrow"]["ends"], "both")
        self.assertEqual(curve["currentProps"]["arrow"]["type"], "open")
        self.assertEqual(curve["currentProps"]["arrow"]["length"]["unit"], "mm")
        self.assertAlmostEqual(curve["currentProps"]["arrow"]["length"]["mm"], 4.0, places=3)
        self.assertEqual(curve["currentProps"]["structureReadonly"], [
            "x", "y", "xend", "yend", "lineend", "curvature", "angle", "ncp", "arrow",
        ])

        for index, obj in enumerate((segment, curve)):
            self.assertEqual(obj["editable"], ["color", "linewidth", "linestyle", "alpha"])
            self.assertFalse(any(
                capability.get("prop") in obj["currentProps"]["structureReadonly"]
                for capability in obj["propertyCapabilities"]
            ))
            relation = obj["identity"].get("relation", {})
            self.assertEqual(relation["arrowId"], f"r.arrow.{index}")
            self.assertNotIn("textId", relation)
            self.assertIn(f"r.arrow.{index}", obj["children"])
        segment_arrow = _object(result, "r.arrow.0")
        curve_arrow = _object(result, "r.arrow.1")
        self.assertEqual(segment_arrow["role"], "ggplot_segment_arrow")
        self.assertEqual(curve_arrow["role"], "ggplot_curve_arrow")
        self.assertEqual(segment_arrow["parentId"], segment["id"])
        self.assertEqual(curve_arrow["parentId"], curve["id"])
        self.assertNotIn("textId", segment_arrow["identity"].get("relation", {}))
        self.assertNotIn("textId", curve_arrow["identity"].get("relation", {}))
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.0"'), 2)
        self.assertEqual(result["svg"].count('data-fig-id="r.arrow.0"'), 2)
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.1"'), 1)
        self.assertEqual(result["svg"].count('data-fig-id="r.arrow.1"'), 2)

    def test_segment_curve_style_replay_preserves_structure_and_rejects_geometry_edits(self):
        script = """
library(ggplot2)
library(grid)
df <- data.frame(x=c(1, 2), y=c(1, 2), xend=c(2.5, 3.5), yend=c(2.2, 1.2))
p <- ggplot(df) +
  geom_segment(
    aes(x=x, y=y, xend=xend, yend=yend),
    colour="#1F78B4", linewidth=0.8, linetype="dashed", alpha=0.75,
    lineend="round", linejoin="mitre",
    arrow=arrow(length=unit(3, "mm"), type="closed", ends="first")
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        segment = _object(baseline, "r.layer.0")
        baseline_structure = {
            key: segment["currentProps"][key]
            for key in ("x", "y", "xend", "yend", "lineend", "linejoin", "arrow")
        }

        patched = _run_r_renderer(script, [
            _backend_patch(segment, "color", "#D62728"),
            _backend_patch(segment, "linewidth", 2.1),
            _backend_patch(segment, "linestyle", "solid"),
            _backend_patch(segment, "alpha", 0.4),
        ])
        patched_segment = _object(patched, "r.layer.0")
        self.assertFalse(patched["conflict"])
        self.assertEqual(len(patched["applied"]), 4)
        self.assertEqual(patched_segment["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_segment["currentProps"]["linewidth"], 2.1)
        self.assertEqual(patched_segment["currentProps"]["linestyle"], "solid")
        self.assertEqual(patched_segment["currentProps"]["alpha"], 0.4)
        self.assertEqual(segment["stableKey"], patched_segment["stableKey"])
        self.assertEqual(segment["fingerprint"], patched_segment["fingerprint"])
        self.assertEqual(segment["identity"], patched_segment["identity"])
        for key, value in baseline_structure.items():
            self.assertEqual(patched_segment["currentProps"][key], value)

        rejected = _run_r_renderer(script, [
            _backend_patch(segment, "xend", [9, 10]),
            _backend_patch(segment, "arrow", {"ends": "last"}),
        ])
        rejected_segment = _object(rejected, "r.layer.0")
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(len(rejected["skipped"]), 2)
        for key, value in baseline_structure.items():
            self.assertEqual(rejected_segment["currentProps"][key], value)

        legacy = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
            {
                "gid": "r.layer.0",
                "prop": "linewidth",
                "value": 1.6,
                "mode": "backend_patch",
                "stableKey": segment["stableKey"],
                "fingerprint": "legacy-style-sensitive-fingerprint",
                "identity": segment["identity"],
            },
        ])
        legacy_segment = _object(legacy, "r.layer.0")
        self.assertFalse(legacy["conflict"])
        self.assertEqual(len(legacy["applied"]), 2)
        self.assertEqual(legacy_segment["currentProps"]["color"], "#2CA02C")
        self.assertEqual(legacy_segment["currentProps"]["linewidth"], 1.6)
        self.assertEqual(legacy_segment["identity"], segment["identity"])

        valid_v2 = _run_r_renderer(script, [
            _backend_patch(segment, "alpha", 0.55),
        ])
        self.assertFalse(valid_v2["conflict"])
        self.assertEqual(_object(valid_v2, "r.layer.0")["currentProps"]["alpha"], 0.55)

        invalid_v2_patch = _backend_patch(segment, "alpha", 0.2)
        invalid_v2_patch["fingerprint"] = "r-v2:invalid-family-9-fingerprint"
        invalid_v2 = _run_r_renderer(script, [invalid_v2_patch])
        self.assertTrue(invalid_v2["conflict"])
        self.assertEqual(invalid_v2["applied"], [])
        self.assertEqual(len(invalid_v2["skipped"]), 1)
        self.assertEqual(_object(invalid_v2, "r.layer.0")["currentProps"]["alpha"], segment["currentProps"]["alpha"])

    def test_segment_curve_svg_identity_survives_prior_same_style_lines(self):
        script = """
library(ggplot2)
library(grid)
line_segment <- data.frame(x=1:3, y=c(1, 2, 1.5))
line_curve <- data.frame(x=1:3, y=c(3, 2.5, 3.5))
segment <- data.frame(x=4, y=1, xend=5.2, yend=2.1)
curve <- data.frame(x=4, y=3, xend=5.2, yend=3.4)
p <- ggplot() +
  geom_line(data=line_segment, aes(x=x, y=y), inherit.aes=FALSE,
            colour="#1F78B4", linewidth=0.8, linetype="solid") +
  geom_line(data=line_curve, aes(x=x, y=y), inherit.aes=FALSE,
            colour="#D95F02", linewidth=0.9, linetype="solid") +
  geom_segment(data=segment, aes(x=x, y=y, xend=xend, yend=yend),
               inherit.aes=FALSE, colour="#1F78B4", linewidth=0.8,
               arrow=arrow(length=unit(3, "mm"), type="closed", ends="last")) +
  geom_curve(data=curve, aes(x=x, y=y, xend=xend, yend=yend),
             inherit.aes=FALSE, colour="#D95F02", linewidth=0.9,
             arrow=arrow(length=unit(3, "mm"), type="open", ends="both")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertEqual(result["status"], "success", result)
        self.assertEqual(result["svg"].count('<polyline data-fig-id="r.layer.0"'), 1)
        self.assertEqual(result["svg"].count('<polyline data-fig-id="r.layer.1"'), 1)
        self.assertEqual(result["svg"].count('<line data-fig-id="r.layer.2"'), 1)
        self.assertEqual(result["svg"].count('<polygon data-fig-id="r.arrow.2"'), 1)
        self.assertEqual(result["svg"].count('<polyline data-fig-id="r.layer.3"'), 1)
        self.assertEqual(result["svg"].count('<polyline data-fig-id="r.arrow.3"'), 2)
        self.assertIn('stroke: #1F78B4', result["svg"])
        self.assertIn('stroke: #D95F02', result["svg"])

    def test_segment_curve_svg_identity_ignores_non_drawable_na_rows(self):
        script = """
library(ggplot2)
library(grid)
segments <- data.frame(
  x=c(1, 2), y=c(1, 2), xend=c(2.5, NA), yend=c(2.2, 1.2)
)
curves <- data.frame(
  x=c(1.2, 2.2), y=c(3.2, 3.6), xend=c(3.8, 4.2), yend=c(3.6, NA)
)
p <- ggplot() +
  geom_segment(
    data=segments, aes(x=x, y=y, xend=xend, yend=yend),
    colour="#1F78B4", linewidth=0.8,
    arrow=arrow(length=unit(3, "mm"), type="closed", ends="last")
  ) +
  geom_curve(
    data=curves, aes(x=x, y=y, xend=xend, yend=yend),
    colour="#D95F02", linewidth=0.9, curvature=0.3,
    arrow=arrow(length=unit(3, "mm"), type="open", ends="both")
  ) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertEqual(result["status"], "success", result)
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.0"'), 1)
        self.assertEqual(result["svg"].count('data-fig-id="r.arrow.0"'), 1)
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.1"'), 1)
        self.assertEqual(result["svg"].count('data-fig-id="r.arrow.1"'), 2)
        self.assertNotIn('data-scifigure-unresolved-owner="r.layer.0"', result["svg"])
        self.assertNotIn('data-scifigure-unresolved-owner="r.layer.1"', result["svg"])

    def test_segment_svg_identity_survives_a_later_layer_with_the_same_style(self):
        script = """
library(ggplot2)
segment <- data.frame(x=1, y=1, xend=2.5, yend=2.2)
trend <- data.frame(x=1:3, y=c(3.0, 3.4, 3.1))
p <- ggplot() +
  geom_segment(data=segment, aes(x=x, y=y, xend=xend, yend=yend),
               inherit.aes=FALSE, colour="#1F78B4", linewidth=0.8) +
  geom_line(data=trend, aes(x=x, y=y), inherit.aes=FALSE,
            colour="#1F78B4", linewidth=0.8) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertEqual(result["svg"].count('<line data-fig-id="r.layer.0"'), 1)
        self.assertEqual(result["svg"].count('<polyline data-fig-id="r.layer.1"'), 1)
        self.assertNotIn('data-scifigure-unresolved-owner="r.layer.0"', result["svg"])

    def test_mapped_segment_curve_styles_remain_scale_owned_and_reject_layer_overrides(self):
        script = """
library(ggplot2)
segment_df <- data.frame(
  x=c(1, 2, 1.5, 2.5), y=c(1, 2, 2.5, 1.5),
  xend=c(2, 3, 2.5, 3.5), yend=c(2, 1, 3.2, 2.2),
  group=c("A", "A", "B", "B"), weight=c(0.6, 0.9, 1.2, 1.5)
)
curve_df <- data.frame(
  x=c(1, 2), y=c(3.5, 4), xend=c(2.5, 3.5), yend=c(4.1, 3.4),
  group=c("A", "B"), opacity=c(0.35, 0.8)
)
p <- ggplot() +
  geom_segment(
    data=segment_df,
    aes(x=x, y=y, xend=xend, yend=yend, colour=group, linewidth=weight, linetype=group),
    alpha=0.7
  ) +
  geom_curve(
    data=curve_df,
    aes(x=x, y=y, xend=xend, yend=yend, alpha=opacity),
    colour="#33A02C", linewidth=0.9, curvature=0.3
  ) +
  scale_colour_manual(values=c(A="#1F78B4", B="#E31A1C")) +
  scale_linetype_manual(values=c(A="solid", B="dashed")) +
  scale_linewidth_continuous(range=c(0.5, 1.5)) +
  scale_alpha_continuous(range=c(0.3, 0.9)) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        segment = _object(baseline, "r.layer.0")
        curve = _object(baseline, "r.layer.1")

        self.assertTrue(segment["currentProps"]["colorMapped"])
        self.assertTrue(segment["currentProps"]["linewidthMapped"])
        self.assertTrue(segment["currentProps"]["linetypeMapped"])
        self.assertFalse(segment["currentProps"]["alphaMapped"])
        self.assertNotIn("color", segment["editable"])
        self.assertNotIn("linewidth", segment["editable"])
        self.assertNotIn("linestyle", segment["editable"])
        self.assertIn("alpha", segment["editable"])

        self.assertFalse(curve["currentProps"]["colorMapped"])
        self.assertFalse(curve["currentProps"]["linewidthMapped"])
        self.assertFalse(curve["currentProps"]["linetypeMapped"])
        self.assertTrue(curve["currentProps"]["alphaMapped"])
        self.assertIn("color", curve["editable"])
        self.assertIn("linewidth", curve["editable"])
        self.assertIn("linestyle", curve["editable"])
        self.assertNotIn("alpha", curve["editable"])

        mapped_props = [
            _backend_patch(segment, "color", "#AA00AA"),
            _backend_patch(segment, "linewidth", 2.5),
            _backend_patch(segment, "linestyle", "dotted"),
            _backend_patch(curve, "alpha", 0.1),
        ]
        rejected = _run_r_renderer(script, mapped_props)
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(len(rejected["skipped"]), len(mapped_props))
        self.assertEqual(_object(rejected, "r.layer.0")["currentProps"], segment["currentProps"])
        self.assertEqual(_object(rejected, "r.layer.1")["currentProps"], curve["currentProps"])
        self.assertNotIn("#aa00aa", rejected["svg"].lower())

        fixed_props = _run_r_renderer(script, [
            _backend_patch(segment, "alpha", 0.45),
            _backend_patch(curve, "color", "#6A3D9A"),
            _backend_patch(curve, "linewidth", 1.7),
        ])
        self.assertFalse(fixed_props["conflict"])
        self.assertEqual(len(fixed_props["applied"]), 3)
        self.assertEqual(_object(fixed_props, "r.layer.0")["currentProps"]["alpha"], 0.45)
        self.assertEqual(_object(fixed_props, "r.layer.1")["currentProps"]["color"], "#6A3D9A")
        self.assertEqual(_object(fixed_props, "r.layer.1")["currentProps"]["linewidth"], 1.7)

    def test_shape_21_point_patch_preserves_fill_outline_stroke_alpha_and_absolute_size(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) +
  geom_point(shape=21, size=4, fill="#A6CEE3", colour="#1F78B4", stroke=0.8, alpha=0.7) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#FB9A99", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "edgecolor", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 1.9, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "alpha", "value": 0.35, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "size", "value": 7, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "marker", "value": 24, "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        for prop in ("facecolor", "edgecolor", "linewidth", "alpha", "size", "marker"):
            self.assertIn(prop, layer["editable"])
        self.assertEqual(layer["currentProps"]["facecolor"], "#FB9A99")
        self.assertEqual(layer["currentProps"]["edgecolor"], "#D62728")
        self.assertEqual(layer["currentProps"]["linewidth"], 1.9)
        self.assertEqual(layer["currentProps"]["alpha"], 0.35)
        self.assertEqual(layer["currentProps"]["size"], 7)
        self.assertEqual(layer["currentProps"]["marker"], 24)
        self.assertIn("#FB9A99".lower(), result["svg"].lower())
        self.assertIn("#D62728".lower(), result["svg"].lower())

    def test_geom_jitter_identity_distinguishes_geom_from_position_jitter(self):
        script = """
library(ggplot2)
df <- data.frame(x=rep(1:2, each=3), y=c(1, 2, 3, 2, 3, 4))
p <- ggplot(df, aes(x, y)) + geom_jitter(width=0.08, height=0, size=3) + theme_classic()
p
"""
        ordinary_script = script.replace(
            "geom_jitter(width=0.08, height=0, size=3)",
            "geom_point(size=3)",
        )
        jitter = _object(_run_r_renderer(script), "r.layer.0")
        ordinary = _object(_run_r_renderer(ordinary_script), "r.layer.0")

        self.assertEqual(jitter["source"]["artistClass"], "GeomPoint")
        self.assertEqual(jitter["source"]["adapterClass"], "GeomJitter")
        self.assertEqual(jitter["currentProps"]["positionClass"], "PositionJitter")
        self.assertIn("PositionJitter", jitter["identity"]["relation"]["layerKey"])
        self.assertNotEqual(jitter["stableKey"], ordinary["stableKey"])
        self.assertNotEqual(jitter["fingerprint"], ordinary["fingerprint"])

    def test_size_scale_patch_preserves_relative_size_ratios_for_mapped_point_sizes(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, weight=c(1, 2, 4, 8))
p <- ggplot(df, aes(x, y, size=weight)) + geom_point() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        scaled = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "size_scale", "value": 2, "mode": "backend_patch"},
        ])
        baseline_layer = _object(baseline, "r.layer.0")
        scaled_layer = _object(scaled, "r.layer.0")

        self.assertIn("size_scale", scaled_layer["editable"])
        self.assertEqual(scaled_layer["currentProps"]["size_scale"], 2)
        self.assertNotEqual(baseline["svg"], scaled["svg"])
        baseline_sizes = baseline_layer["currentProps"]["sizes"]
        scaled_sizes = scaled_layer["currentProps"]["sizes"]
        self.assertEqual(len(baseline_sizes), len(scaled_sizes))
        self.assertGreater(len(set(baseline_sizes)), 1)
        for baseline_size, scaled_size in zip(baseline_sizes, scaled_sizes):
            self.assertAlmostEqual(scaled_size / baseline_size, 2, places=5)

    def test_absolute_size_patch_and_size_scale_patch_are_distinct_point_operations(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, weight=c(1, 2, 4, 8))
p <- ggplot(df, aes(x, y, size=weight)) + geom_point() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        absolute = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "size", "value": 8, "mode": "backend_patch"},
        ])
        scaled = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "size_scale", "value": 2, "mode": "backend_patch"},
        ])
        absolute_layer = _object(absolute, "r.layer.0")
        scaled_layer = _object(scaled, "r.layer.0")
        baseline_layer = _object(baseline, "r.layer.0")

        self.assertIn("size_scale", absolute_layer["currentProps"])
        self.assertIn("size_scale", scaled_layer["currentProps"])
        self.assertIn("sizes", absolute_layer["currentProps"])
        self.assertIn("sizes", scaled_layer["currentProps"])
        self.assertEqual(absolute_layer["currentProps"]["size"], 8)
        self.assertEqual(absolute_layer["currentProps"]["size_scale"], 1)
        self.assertEqual(scaled_layer["currentProps"]["size"], baseline_layer["currentProps"]["size"])
        self.assertEqual(scaled_layer["currentProps"]["size_scale"], 2)
        self.assertEqual(len(set(absolute_layer["currentProps"]["sizes"])), 1)
        self.assertGreater(len(set(scaled_layer["currentProps"]["sizes"])), 1)

    def test_shape_19_and_shape_21_expose_fill_outline_boundary(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:3, y=c(2, 4, 3))
p <- ggplot(df, aes(x, y)) +
  geom_point(shape=19, size=4, colour="#1F78B4") +
  geom_point(shape=21, size=4, fill="#A6CEE3", colour="#D62728", stroke=0.9) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        solid_point = _object(result, "r.layer.0")
        filled_outline_point = _object(result, "r.layer.1")

        self.assertIn("color", solid_point["editable"])
        self.assertIn("marker", solid_point["editable"])
        self.assertNotIn("facecolor", solid_point["editable"])
        self.assertNotIn("edgecolor", solid_point["editable"])
        self.assertNotIn("linewidth", solid_point["editable"])
        self.assertIn("facecolor", filled_outline_point["editable"])
        self.assertIn("edgecolor", filled_outline_point["editable"])
        self.assertIn("linewidth", filled_outline_point["editable"])
        self.assertIn("marker", filled_outline_point["editable"])
        solid_capabilities = {item["prop"]: item for item in solid_point["propertyCapabilities"]}
        fillable_capabilities = {item["prop"]: item for item in filled_outline_point["propertyCapabilities"]}
        self.assertNotIn("facecolor", solid_capabilities)
        for prop in ("marker", "size", "size_scale", "color", "alpha"):
            self.assertEqual(solid_capabilities[prop]["patchMode"], "backend_patch")
        for prop in ("facecolor", "edgecolor", "linewidth"):
            self.assertEqual(fillable_capabilities[prop]["patchMode"], "backend_patch")

    def test_point_adapter_keeps_legacy_r_layer_gid_and_identityless_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertEqual(result["applied"][0]["gid"], "r.layer.0")
        self.assertNotIn("resolvedGid", result["applied"][0])
        self.assertEqual(layer["currentProps"]["adapterFamily"], "point")
        self.assertEqual(layer["currentProps"]["color"], "#2CA02C")
        self.assertIn("#2CA02C".lower(), result["svg"].lower())

    def test_legacy_shape_19_facecolor_patch_migrates_to_visible_point_color(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(size=3) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#2CA02C", "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertNotIn("facecolor", layer["editable"])
        self.assertEqual(layer["currentProps"]["color"], "#2CA02C")
        self.assertEqual(result["applied"][0]["prop"], "facecolor")
        self.assertTrue(any(
            warning.get("type") == "legacy_prop_alias"
            and warning.get("gid") == "r.layer.0"
            and warning.get("fromProp") == "facecolor"
            and warning.get("toProp") == "color"
            for warning in result["warnings"]
            if isinstance(warning, dict)
        ))
        self.assertIn("#2CA02C".lower(), result["svg"].lower())

    def test_mapped_fillable_point_shape_supports_facecolor_patch(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=rep(c("A", "B"), 2))
p <- ggplot(df, aes(x, y, shape=group)) +
  geom_point(size=4, fill="#A6CEE3", colour="#1F78B4", stroke=0.8) +
  scale_shape_manual(values=c(A=21, B=22)) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#FB9A99", "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertTrue(layer["currentProps"]["fillSupported"])
        self.assertIn("facecolor", layer["editable"])
        self.assertEqual(layer["currentProps"]["facecolor"], "#FB9A99")
        self.assertEqual(sorted(layer["currentProps"]["markerValues"]), [21, 22])
        self.assertIn("#FB9A99".lower(), result["svg"].lower())

    def test_mapped_mixed_point_shapes_do_not_expose_fill_until_marker_is_unified(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=rep(c("A", "B"), 2))
p <- ggplot(df, aes(x, y, shape=group)) +
  geom_point(size=4, fill="#A6CEE3", colour="#1F78B4", stroke=0.8) +
  scale_shape_manual(values=c(A=19, B=21)) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "marker", "value": 21, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#FB9A99", "mode": "backend_patch"},
        ])
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertFalse(baseline_layer["currentProps"]["fillSupported"])
        self.assertNotIn("facecolor", baseline_layer["editable"])
        self.assertFalse(patched["conflict"])
        self.assertTrue(patched_layer["currentProps"]["fillSupported"])
        self.assertEqual(patched_layer["currentProps"]["marker"], 21)
        self.assertEqual(patched_layer["currentProps"]["facecolor"], "#FB9A99")

    def test_same_batch_marker_upgrade_then_facecolor_targets_fill(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) + geom_point(shape=19, size=4, colour="#1F78B4") + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "marker", "value": 21, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#FB9A99", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "edgecolor", "value": "#D62728", "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertEqual(layer["currentProps"]["marker"], 21)
        self.assertTrue(layer["currentProps"]["fillSupported"])
        self.assertEqual(layer["currentProps"]["facecolor"], "#FB9A99")
        self.assertEqual(layer["currentProps"]["edgecolor"], "#D62728")
        self.assertIn("#FB9A99".lower(), result["svg"].lower())
        self.assertIn("#D62728".lower(), result["svg"].lower())

    def test_point_color_edgecolor_alias_confirms_latest_value_only(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
p <- ggplot(df, aes(x, y)) +
  geom_point(shape=21, size=4, fill="#A6CEE3", colour="#1F78B4", stroke=0.8) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#111111", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "edgecolor", "value": "#D62728", "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertTrue(result["applied"][0].get("superseded"))
        self.assertEqual(layer["currentProps"]["color"], "#D62728")
        self.assertEqual(layer["currentProps"]["edgecolor"], "#D62728")
        self.assertIn("#D62728".lower(), result["svg"].lower())

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

    def test_fixed_line_sharing_discrete_group_color_keeps_own_svg_gid(self):
        script = """
library(ggplot2)
series <- data.frame(
  x=rep(1:3, 2),
  y=c(1.0, 1.5, 2.0, 2.2, 2.6, 3.1),
  group=rep(c("A", "B"), each=3)
)
fixed <- data.frame(x=1:3, y=c(3.6, 3.8, 3.7), group="A")
p <- ggplot(series, aes(x=x, y=y, colour=group, group=group)) +
  geom_line(linewidth=0.7) +
  geom_point(size=2.4) +
  geom_line(data=fixed, aes(x=x, y=y), colour="#1F78B4", linewidth=0.9) +
  scale_colour_manual(values=c(A="#1F78B4", B="#D62728")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertIn('data-fig-id="r.group.color.0.0"', result["svg"])
        self.assertIn('data-fig-id="r.group.color.0.1"', result["svg"])
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.2"'), 1)

    def test_css_default_black_uses_exact_ownership_or_fails_closed(self):
        mapped_script = """
library(ggplot2)
df <- data.frame(
  x=rep(1:3, 2),
  y=c(1.0, 1.4, 1.8, 2.2, 2.7, 3.0),
  group=rep(c("A", "B"), each=3)
)
p <- ggplot(df, aes(x=x, y=y, colour=group, group=group)) +
  geom_line(linewidth=0.8) +
  scale_colour_manual(values=c(A="#000000", B="#D62728")) +
  theme_classic()
p
"""
        mapped = _run_r_renderer(mapped_script)
        self.assertIn('data-fig-id="r.group.color.0.0"', mapped["svg"])
        self.assertIn('data-fig-id="r.group.color.0.1"', mapped["svg"])

        ambiguous_script = """
library(ggplot2)
first <- data.frame(x=1:3, y=c(1.0, 1.4, 1.8))
second <- data.frame(x=1:3, y=c(2.2, 2.7, 3.0))
p <- ggplot() +
  geom_line(data=first, aes(x=x, y=y), inherit.aes=FALSE) +
  geom_line(data=second, aes(x=x, y=y), inherit.aes=FALSE) +
  theme_classic()
p
"""
        ambiguous = _run_r_renderer(ambiguous_script)
        self.assertEqual(ambiguous["svg"].count('data-fig-id="r.layer.0"'), 1)
        self.assertEqual(ambiguous["svg"].count('data-fig-id="r.layer.1"'), 1)

    def test_ordered_svg_ownership_uses_geom_filtered_drawable_rows(self):
        script = """
library(ggplot2)
missing <- data.frame(x=NA_real_, y=NA_real_)
visible <- data.frame(x=1, y=1)
p <- ggplot() +
  geom_point(data=missing, aes(x=x, y=y), inherit.aes=FALSE, colour="#1F78B4", size=3) +
  geom_point(data=visible, aes(x=x, y=y), inherit.aes=FALSE, colour="#1F78B4", size=3) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertNotIn('data-fig-id="r.layer.0"', result["svg"])
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.1"'), 1)

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

    def test_discrete_scale_patch_preserves_breaks_na_drop_and_guide_semantics(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=1:5,
  y=1:5,
  group=factor(c("A", "B", NA, "A", "B"), levels=c("A", "B", "C"))
)
p <- ggplot(df, aes(x, y, colour=group)) +
  geom_point(size=4) +
  scale_colour_manual(
    values=c(A="#1F78B4", B="#D62728", C="#33A02C"),
    limits=c("C", "B", "A"),
    breaks=c("B", "A"),
    labels=c(B="Beta", A="Alpha"),
    drop=FALSE,
    na.value="#999999",
    na.translate=TRUE,
    guide=guide_legend(reverse=TRUE, order=2),
    name="Treatment"
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.group.color.0.1", "prop": "color", "value": "#6A3D9A", "mode": "backend_patch"},
        ])

        scale = _object(patched, "r.scale.color.0")
        self.assertEqual(scale["role"], "ggplot_scale_discrete")
        self.assertEqual(scale["currentProps"]["limits"], ["C", "B", "A"])
        self.assertEqual(scale["currentProps"]["breaks"], ["B", "A"])
        self.assertEqual(scale["currentProps"]["labels"], ["Beta", "Alpha"])
        self.assertFalse(scale["currentProps"]["drop"])
        self.assertTrue(scale["currentProps"]["naTranslate"])
        self.assertEqual(scale["currentProps"]["naValue"], "#999999")
        self.assertEqual(scale["currentProps"]["guideType"], "legend")
        self.assertTrue(scale["currentProps"]["guideVisible"])
        self.assertTrue(scale["currentProps"]["guideReverse"])
        self.assertEqual(scale["currentProps"]["guideOrder"], 2)
        self.assertEqual(
            [obj["currentProps"]["text"] for obj in _objects(patched) if obj.get("role") == "legend_text"],
            ["Beta", "Alpha"],
        )
        self.assertEqual(_object(patched, "r.group.color.0.1")["currentProps"]["color"], "#6A3D9A")
        self.assertEqual(scale["stableKey"], _object(baseline, "r.scale.color.0")["stableKey"])

    def test_free_facet_declares_axis_strip_and_panel_spacing_capabilities(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c(1, 2, 10, 20), y=c(1, 2, 100, 200),
  facet=c("F1", "F1", "F2", "F2")
)
p <- ggplot(df, aes(x, y)) +
  geom_point() +
  facet_wrap(~facet, scales="free", strip.position="bottom") +
  theme_classic() +
  theme(panel.spacing.x=unit(7, "pt"), panel.spacing.y=unit(9, "pt"))
p
"""
        result = _run_r_renderer(script)
        panels = [obj for obj in _objects(result) if obj.get("role") == "ggplot_facet_panel"]
        layout = _object(result, "r.facet.layout.0")
        strip = _object(result, "facet.strip.0")

        self.assertEqual(len(panels), 2)
        self.assertEqual({panel["identity"]["relation"]["facetKey"] for panel in panels}, {"facet=F1", "facet=F2"})
        for panel in panels:
            self.assertTrue(panel["currentProps"]["freeX"])
            self.assertTrue(panel["currentProps"]["freeY"])
            self.assertEqual(panel["currentProps"]["facetScales"], "free")
            self.assertNotIn("left", panel["editable"])
            self.assertNotIn("width", panel["editable"])
        self.assertEqual(layout["currentProps"]["stripPosition"], "bottom")
        self.assertEqual(layout["currentProps"]["panelSpacingXPt"], 7)
        self.assertEqual(layout["currentProps"]["panelSpacingYPt"], 9)
        self.assertEqual(layout["currentProps"]["physicalPanelBounds"], "readonly")
        self.assertEqual(strip["identity"]["relation"]["parentId"], layout["id"])

    def test_semantic_guide_object_owns_readonly_legend_key_glyphs(self):
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
        guides = [obj for obj in _objects(result) if obj.get("id") == "r.guide.legend.0"]
        key_glyphs = [
            obj for obj in _objects(result)
            if obj.get("role") == "legend_key_glyph"
        ]
        legend_text = [
            obj for obj in _objects(result)
            if obj.get("role") == "legend_text"
        ]

        self.assertEqual(
            len(guides),
            1,
            "expected first-class semantic guide object r.guide.legend.0",
        )
        guide = guides[0]
        self.assertEqual(guide["kind"], "guide")
        self.assertEqual(guide["role"], "ggplot_semantic_guide")
        self.assertEqual(guide["editable"], ["visible"])
        self.assertEqual(guide["identity"]["relation"]["legendId"], "legend.0")
        self.assertEqual(guide["identity"]["relation"]["guideType"], "legend")
        self.assertEqual(guide["identity"]["relation"]["legendTitleId"], "legend_title.0")
        self.assertEqual(guide["identity"]["relation"]["legendTextIds"], [text["id"] for text in legend_text])
        self.assertEqual(guide["identity"]["relation"]["legendMarkerIds"], [glyph["id"] for glyph in key_glyphs])
        self.assertEqual(len(key_glyphs), 2)
        self.assertEqual(len(legend_text), 2)
        for glyph in key_glyphs:
            relation = glyph["identity"]["relation"]
            self.assertEqual(glyph["editable"], [])
            self.assertEqual(relation["guideId"], guide["id"])
            self.assertEqual(relation["legendId"], "legend.0")
            self.assertIn(relation["dataKey"], {text["identity"]["relation"]["dataKey"] for text in legend_text})
            self.assertIn("scaleKey", relation)
            self.assertIn("groupIds", relation)

    def test_semantic_guide_records_all_owner_layers_groups_and_children(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:6, y=c(1, 3, 2, 5, 4, 6), group=rep(c("A", "B"), 3))
p <- ggplot(df, aes(x, y, colour=group)) +
  geom_line() +
  geom_point(size=4) +
  scale_colour_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        guide = _object(result, "r.guide.legend.0")
        relation = guide["identity"]["relation"]
        legend_text_ids = [obj["id"] for obj in _objects(result) if obj.get("role") == "legend_text"]
        key_glyph_ids = [obj["id"] for obj in _objects(result) if obj.get("role") == "legend_key_glyph"]

        self.assertEqual(relation["layerIds"], ["r.layer.0", "r.layer.1"])
        self.assertEqual(relation["subplotIds"], ["subplot.0"])
        self.assertEqual(relation["scaleIds"], ["r.scale.color.0"])
        self.assertEqual(relation["groupIds"], ["r.group.color.0.0", "r.group.color.0.1"])
        self.assertEqual(relation["legendTitleId"], "legend_title.0")
        self.assertEqual(relation["legendTextIds"], legend_text_ids)
        self.assertEqual(relation["legendMarkerIds"], key_glyph_ids)
        for object_id in legend_text_ids + key_glyph_ids:
            child = _object(result, object_id)
            child_relation = child["identity"]["relation"]
            self.assertIn(child_relation.get("semanticGuideId", child_relation.get("guideId")), {guide["id"], "legend.0"})

    def test_semantic_guide_visibility_can_hide_and_restore_without_identity_drift(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, group=rep(c("A", "B"), 2))
p <- ggplot(df, aes(x, y, colour=group)) +
  geom_point(size=4) +
  scale_colour_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        guide = _object(baseline, "r.guide.legend.0")
        hidden = _run_r_renderer(script, [_backend_patch(guide, "visible", False)])
        hidden_guide = _object(hidden, guide["id"])
        restored = _run_r_renderer(script, [
            _backend_patch(guide, "visible", False),
            _backend_patch(hidden_guide, "visible", True),
        ])

        self.assertFalse(hidden["conflict"])
        self.assertFalse(hidden_guide["currentProps"]["visible"])
        self.assertNotIn("Group", hidden["svg"])
        self.assertTrue(_object(restored, guide["id"])["currentProps"]["visible"])
        self.assertIn("Group", restored["svg"])
        self.assertEqual(_object(restored, guide["id"])["stableKey"], guide["stableKey"])
        self.assertEqual(_object(restored, guide["id"])["fingerprint"], guide["fingerprint"])

    def test_continuous_scale_cmap_patch_preserves_scale_and_guide_semantics(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:3, y=1:3)
df$value <- c(0, 0.2, 0.4, 0.6, 0.8, 1, NA, 0.25, 0.75)
p <- ggplot(df, aes(x, y, fill=value)) +
  geom_tile() +
  scale_fill_gradientn(
    colours=c("#132B43", "#56B1F7", "#FDE725"),
    trans="sqrt",
    limits=c(0, 1),
    breaks=c(0, 0.25, 1),
    labels=c("Zero", "Quarter", "One"),
    na.value="#999999",
    guide=guide_colourbar(reverse=TRUE, order=3),
    name="Intensity"
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.heatmap.fill.0", "prop": "cmap", "value": "plasma", "mode": "backend_patch"},
        ])
        baseline_scale = _object(baseline, "r.scale.fill.continuous.0")
        patched_scale = _object(patched, "r.scale.fill.continuous.0")
        patched_heatmap = _object(patched, "r.heatmap.fill.0")
        patched_colorbar = _object(patched, "r.colorbar.fill.0")

        self.assertFalse(patched["conflict"])
        self.assertEqual(patched_heatmap["currentProps"]["cmap"], "plasma")
        self.assertEqual(patched_colorbar["currentProps"]["cmap"], "plasma")
        self.assertEqual(patched_scale["role"], "ggplot_scale_continuous")
        self.assertEqual(patched_scale["currentProps"]["transform"], "sqrt")
        self.assertEqual(patched_scale["currentProps"]["breaks"], [0, 0.25, 1])
        self.assertEqual(patched_scale["currentProps"]["labels"], ["Zero", "Quarter", "One"])
        self.assertEqual(patched_scale["currentProps"]["naValue"], "#999999")
        self.assertEqual(patched_scale["currentProps"]["guideType"], "colorbar")
        self.assertTrue(patched_scale["currentProps"]["guideVisible"])
        self.assertTrue(patched_scale["currentProps"]["guideReverse"])
        self.assertEqual(patched_scale["currentProps"]["guideOrder"], 3)
        self.assertEqual(patched_scale["stableKey"], baseline_scale["stableKey"])
        self.assertEqual(patched_scale["fingerprint"], baseline_scale["fingerprint"])
        self.assertEqual(patched_scale["identity"], baseline_scale["identity"])
        for label in ["Zero", "Quarter", "One"]:
            self.assertIn(label, patched["svg"])
        self.assertIn("#999999".lower(), patched["svg"].lower())

    def test_default_gradient_uses_colorbar_guide_type(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:3, y=1:3)
df$value <- seq(0, 1, length.out=nrow(df))
p <- ggplot(df, aes(x, y, fill=value)) +
  geom_tile() +
  scale_fill_gradient(low="#132B43", high="#56B1F7", name="Intensity") +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        scale = _object(result, "r.scale.fill.continuous.0")

        self.assertEqual(scale["currentProps"]["guideType"], "colorbar")
        self.assertTrue(scale["currentProps"]["guideVisible"])

    def test_continuous_colorbar_visibility_is_shared_with_scale_and_restorable(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:3, y=1:3)
df$value <- seq(0, 1, length.out=nrow(df))
p <- ggplot(df, aes(x, y, fill=value)) +
  geom_tile() +
  scale_fill_gradient(low="#132B43", high="#56B1F7", name="Intensity") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        colorbar = _object(baseline, "r.colorbar.fill.0")
        hidden = _run_r_renderer(script, [_backend_patch(colorbar, "visible", False)])
        hidden_colorbar = _object(hidden, colorbar["id"])
        hidden_scale = _object(hidden, "r.scale.fill.continuous.0")
        restored = _run_r_renderer(script, [
            _backend_patch(colorbar, "visible", False),
            _backend_patch(hidden_colorbar, "visible", True),
        ])

        self.assertFalse(hidden["conflict"])
        self.assertFalse(hidden_colorbar["currentProps"]["visible"])
        self.assertFalse(hidden_scale["currentProps"]["guideVisible"])
        self.assertNotIn("Intensity", hidden["svg"])
        self.assertFalse(restored["conflict"])
        self.assertTrue(_object(restored, colorbar["id"])["currentProps"]["visible"])
        self.assertTrue(_object(restored, "r.scale.fill.continuous.0")["currentProps"]["guideVisible"])
        self.assertIn("Intensity", restored["svg"])
        self.assertEqual(_object(restored, colorbar["id"])["stableKey"], colorbar["stableKey"])

    def test_free_facet_tick_identity_does_not_cross_panels(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c("A", "B", "A", "B"),
  y=c(1, 2, 100, 200),
  facet=c("F1", "F1", "F2", "F2")
)
p <- ggplot(df, aes(x, y)) +
  geom_col() +
  facet_wrap(~facet, scales="free_x") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("kind") == "xtick"
            and obj["identity"]["relation"].get("facetKey") == "facet=F2"
            and obj["currentProps"]["text"] == "A"
        )
        neighbor = next(
            obj for obj in _objects(baseline)
            if obj.get("kind") == "xtick"
            and obj["identity"]["relation"].get("facetKey") == "facet=F1"
            and obj["currentProps"]["text"] == "A"
        )

        patched = _run_r_renderer(script, [_backend_patch(target, "fontsize", 17)])
        patched_target = _object(patched, target["id"])
        patched_neighbor = _object(patched, neighbor["id"])

        self.assertNotEqual(target["stableKey"], neighbor["stableKey"])
        self.assertNotEqual(target["fingerprint"], neighbor["fingerprint"])
        self.assertFalse(patched["conflict"])
        self.assertEqual(patched_target["currentProps"]["fontsize"], 17)
        self.assertEqual(patched_neighbor["currentProps"]["fontsize"], neighbor["currentProps"]["fontsize"])
        self.assertEqual(patched_target["identity"]["relation"]["facetKey"], "facet=F2")
        self.assertEqual(patched_neighbor["identity"]["relation"]["facetKey"], "facet=F1")

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
df <- data.frame(
  group=rep(c("A", "B"), each=10),
  value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22)
)
p <- ggplot(df, aes(group, value, fill=group)) +
  geom_boxplot(alpha=0.7, outlier.shape=21, outlier.fill="white") +
  geom_violin(alpha=0.3, draw_quantiles=0.5) +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "box_color", "value": "#2CA02C", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "color", "value": "#AA0000", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 2, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_color", "value": "#DE2D26", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_fill", "value": "#FEE0D2", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_shape", "value": 24, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_size", "value": 2.6, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_stroke", "value": 0.8, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "outlier_alpha", "value": 0.65, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "facecolor", "value": "#9467BD", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "edgecolor", "value": "#111111", "mode": "backend_patch"},
        ])
        box = _object(result, "r.layer.0")
        violin = _object(result, "r.layer.1")

        self.assertFalse(result["conflict"])
        self.assertEqual(box["kind"], "boxplot_container")
        self.assertIn("box_color", box["editable"])
        self.assertNotIn("median_color", box["editable"])
        self.assertNotIn("median_color", box["currentProps"])
        self.assertEqual(box["currentProps"]["adapterFamily"], "boxplot")
        self.assertEqual(
            box["currentProps"]["componentRoles"],
            ["box_body", "median", "whiskers", "staples", "outliers"],
        )
        self.assertEqual(box["currentProps"]["box_color"], "#2CA02C")
        self.assertEqual(box["currentProps"]["color"], "#AA0000")
        self.assertEqual(box["currentProps"]["linewidth"], 2)
        self.assertEqual(box["currentProps"]["outlier_color"], "#DE2D26")
        self.assertEqual(box["currentProps"]["outlier_fill"], "#FEE0D2")
        self.assertEqual(box["currentProps"]["outlier_shape"], 24)
        self.assertEqual(box["currentProps"]["outlier_size"], 2.6)
        self.assertEqual(box["currentProps"]["outlier_stroke"], 0.8)
        self.assertEqual(box["currentProps"]["outlier_alpha"], 0.65)
        for prop in (
            "outlier_color", "outlier_fill", "outlier_shape",
            "outlier_size", "outlier_stroke", "outlier_alpha",
        ):
            self.assertIn(prop, box["editable"])
        self.assertEqual(violin["kind"], "violinplot_container")
        self.assertIn("facecolor", violin["editable"])
        self.assertNotIn("color", violin["editable"])
        self.assertNotIn("color", violin["currentProps"])
        self.assertNotIn("quantile_color", violin["editable"])
        self.assertNotIn("quantile_linewidth", violin["editable"])
        self.assertEqual(violin["currentProps"]["facecolor"], "#9467BD")
        self.assertEqual(violin["currentProps"]["edgecolor"], "#111111")
        self.assertEqual(violin["currentProps"]["adapterFamily"], "violin")
        self.assertEqual(violin["currentProps"]["componentRoles"], ["body", "quantile_lines"])
        self.assertEqual(violin["currentProps"]["quantileCount"], 1)
        distribution_groups = [
            group for group in result["manifest"]["groups"]
            if group.get("aesthetic") == "fill"
        ]
        self.assertTrue(distribution_groups)
        self.assertTrue(all(group["kind"] == "distribution" for group in distribution_groups))
        self.assertTrue(all(set(group["geomFamilies"]) == {"GeomBoxplot", "GeomViolin"} for group in distribution_groups))
        fill_group = _object(result, "r.group.fill.0.0")
        self.assertEqual(fill_group["currentProps"]["semanticKind"], "distribution")
        self.assertEqual(set(fill_group["currentProps"]["geomFamilies"]), {"GeomBoxplot", "GeomViolin"})

    def test_boxplot_legacy_median_color_alias_replays_as_outline_with_warning(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=8), value=c(1:8, 3:10))
p <- ggplot(df, aes(group, value, fill=group)) + geom_boxplot() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        box = _object(baseline, "r.layer.0")
        result = _run_r_renderer(script, [_backend_patch(box, "median_color", "#AA0000")])
        rendered_box = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertNotIn("median_color", rendered_box["editable"])
        self.assertNotIn("median_color", rendered_box["currentProps"])
        self.assertEqual(rendered_box["currentProps"]["color"], "#AA0000")
        self.assertEqual(result["applied"][0]["prop"], "median_color")
        self.assertTrue(any(
            warning.get("type") == "legacy_prop_alias"
            and warning.get("gid") == "r.layer.0"
            and warning.get("fromProp") == "median_color"
            and warning.get("toProp") == "color"
            for warning in result["warnings"]
            if isinstance(warning, dict)
        ))

    def test_boxplot_outlier_fill_requires_a_fillable_shape(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22))
p <- ggplot(df, aes(group, value)) + geom_boxplot() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        box = _object(baseline, "r.layer.0")

        self.assertEqual(box["currentProps"]["outlier_shape"], 19)
        self.assertFalse(box["currentProps"]["outlierFillSupported"])
        self.assertNotIn("outlier_fill", box["editable"])
        self.assertNotIn("outlier_fill", [item["prop"] for item in box["propertyCapabilities"]])
        self.assertNotIn("outlier_fill", baseline["manifest"]["coverageReport"]["byKind"]["boxplot_container"]["editableProps"])

        rejected = _run_r_renderer(script, [_backend_patch(box, "outlier_fill", "#FEE0D2")])
        self.assertTrue(rejected["conflict"])
        self.assertTrue(any(
            entry.get("prop") == "outlier_fill"
            for entry in rejected["skipped"]
            if isinstance(entry, dict)
        ))

    def test_boxplot_outlier_supported_style_changes_are_present_in_svg(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22))
p <- ggplot(df, aes(group, value)) + geom_boxplot(outlier.shape=21, outlier.fill="white") + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        box = _object(baseline, "r.layer.0")
        color_patch = _run_r_renderer(script, [_backend_patch(box, "outlier_color", "#00AA55")])
        shape_patch = _run_r_renderer(script, [_backend_patch(box, "outlier_shape", 24)])
        size_patch = _run_r_renderer(script, [_backend_patch(box, "outlier_size", 4.2)])

        self.assertIn("#00aa55", color_patch["svg"].lower())
        self.assertNotEqual(baseline["svg"], shape_patch["svg"])
        self.assertNotEqual(baseline["svg"], size_patch["svg"])

    def test_boxplot_outlier_component_mismatch_does_not_consume_following_same_color_line(self):
        scripts = [
            """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22))
trend <- data.frame(x=c(0.8, 2.2), y=c(12, 18))
p <- ggplot(df, aes(group, value)) +
  geom_boxplot(colour="#1F78B4", fill="#A6CEE3", outlier.shape=NA) +
  geom_line(data=trend, aes(x=x, y=y), inherit.aes=FALSE, colour="#1F78B4", linewidth=0.8) +
  theme_classic()
p
""",
            """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22))
trend <- data.frame(x=c(0.8, 2.2), y=c(12, 18))
p <- ggplot(df, aes(group, value)) +
  geom_boxplot(colour="#333333", fill="#A6CEE3", outlier.colour="#1F78B4", outlier.shape=19) +
  geom_line(data=trend, aes(x=x, y=y), inherit.aes=FALSE, colour="#1F78B4", linewidth=0.8) +
  theme_classic()
p
""",
        ]

        for script in scripts:
            with self.subTest(script=script):
                result = _run_r_renderer(script)
                self.assertEqual(result["svg"].count('data-fig-id="r.layer.1"'), 1)

    def test_boxplot_fill_edit_becomes_dormant_when_a_later_shape_is_not_fillable(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 20, 3, 4, 4, 5, 5, 6, 6, 7, 7, 22))
p <- ggplot(df, aes(group, value)) + geom_boxplot(outlier.shape=21, outlier.fill="white") + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        box = _object(baseline, "r.layer.0")
        fill_edit = _backend_patch(box, "outlier_fill", "#FEE0D2")
        shape_edit = _backend_patch(box, "outlier_shape", 19)
        result = _run_r_renderer(script, [fill_edit, shape_edit])
        rendered_box = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertEqual(rendered_box["currentProps"]["outlier_shape"], 19)
        self.assertFalse(rendered_box["currentProps"]["outlierFillSupported"])
        self.assertNotIn("outlier_fill", rendered_box["editable"])
        self.assertTrue(result["applied"][0].get("superseded"))

    def test_violin_legacy_color_alias_replays_as_edgecolor_with_warning(self):
        script = """
library(ggplot2)
df <- data.frame(group=rep(c("A", "B"), each=10), value=c(1:10, 3:12))
p <- ggplot(df, aes(group, value, fill=group)) + geom_violin() + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        violin = _object(baseline, "r.layer.0")
        result = _run_r_renderer(script, [_backend_patch(violin, "color", "#54278F")])
        rendered_violin = _object(result, "r.layer.0")

        self.assertFalse(result["conflict"])
        self.assertNotIn("color", rendered_violin["editable"])
        self.assertNotIn("color", rendered_violin["currentProps"])
        self.assertEqual(rendered_violin["currentProps"]["edgecolor"], "#54278F")
        self.assertTrue(any(
            warning.get("type") == "legacy_prop_alias"
            and warning.get("gid") == "r.layer.0"
            and warning.get("fromProp") == "color"
            and warning.get("toProp") == "edgecolor"
            for warning in result["warnings"]
            if isinstance(warning, dict)
        ))

    def test_distribution_non_fill_style_edits_keep_fill_groups_active(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(c(1, 2), each=12),
  value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 18, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 20),
  group=rep(c("C", "D"), each=12)
)
p <- ggplot() +
  geom_violin(
    data=df,
    aes(x=x, y=value, group=group, fill=group),
    alpha=0.25, colour="#238B45", linewidth=0.6
  ) +
  geom_boxplot(
    data=df,
    aes(x=x, y=value, group=group, fill=group),
    width=0.22, alpha=0.75, colour="#333333", linewidth=0.55,
    outlier.shape=21, outlier.fill="white"
  ) +
  scale_fill_manual(values=c(C="#B3DE69", D="#FCCDE5")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        violin = _object(baseline, "r.layer.0")
        boxplot = _object(baseline, "r.layer.1")
        style_edits = [
            _backend_patch(violin, "edgecolor", "#54278F"),
            _backend_patch(violin, "linewidth", 1.35),
            _backend_patch(boxplot, "outlier_color", "#DE2D26"),
            _backend_patch(boxplot, "outlier_shape", 24),
            _backend_patch(boxplot, "outlier_size", 3.2),
        ]
        styled = _run_r_renderer(script, style_edits)
        fill_groups = [
            obj for obj in styled["manifest"]["objects"]
            if obj["id"].startswith("r.group.fill.")
        ]

        self.assertFalse(styled["conflict"])
        self.assertEqual(len(fill_groups), 2)
        self.assertTrue(all(group["currentProps"]["scaleActive"] for group in fill_groups))

        palette_edit = _backend_patch(fill_groups[0], "facecolor", "#FB9A99")
        replayed = _run_r_renderer(script, [*style_edits, palette_edit])
        self.assertFalse(replayed["conflict"])
        self.assertIn("#fb9a99", replayed["svg"].lower())

    def test_fill_group_identity_survives_active_key_compaction(self):
        script = """
library(ggplot2)
bars <- data.frame(x=1:4, y=c(1, 2, 1.5, 2.5), group=c("A", "A", "B", "B"))
dist <- data.frame(
  x=rep(c(5, 6), each=12),
  value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 18, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 20),
  group=rep(c("C", "D"), each=12)
)
band <- data.frame(
  x=rep(7:10, 2),
  ymin=c(0.8, 1.2, 1.0, 1.5, 1.4, 1.9, 1.6, 2.2),
  ymax=c(1.5, 2.0, 1.8, 2.4, 2.1, 2.8, 2.5, 3.2),
  group=rep(c("E", "F"), each=4)
)
area <- data.frame(
  x=rep(7:10, 2),
  y=c(0.7, 1.1, 0.9, 1.4, 1.2, 1.7, 1.5, 2.0),
  group=rep(c("E", "F"), each=4)
)
p <- ggplot() +
  geom_col(data=bars, aes(x=x, y=y, fill=group), width=0.5) +
  geom_violin(
    data=dist,
    aes(x=x, y=value, group=group, fill=group),
    alpha=0.25, colour="#238B45", linewidth=0.6
  ) +
  geom_boxplot(
    data=dist,
    aes(x=x, y=value, group=group, fill=group),
    width=0.22, alpha=0.75, colour="#333333", linewidth=0.55,
    outlier.shape=21, outlier.fill="white"
  ) +
  geom_ribbon(
    data=band,
    aes(x=x, ymin=ymin, ymax=ymax, group=group, fill=group),
    inherit.aes=FALSE, position="identity", alpha=0.3
  ) +
  geom_area(
    data=area,
    aes(x=x, y=y, group=group, fill=group),
    inherit.aes=FALSE, position="identity", alpha=0.2
  ) +
  scale_fill_manual(values=c(
    A="#80B1D3", B="#FDB462", C="#B3DE69",
    D="#FCCDE5", E="#92C5DE", F="#A6D96A"
  )) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        style_edits = [
            _backend_patch(_object(baseline, "r.layer.0"), "facecolor", "#FDD0A2"),
            _backend_patch(_object(baseline, "r.layer.1"), "edgecolor", "#54278F"),
            _backend_patch(_object(baseline, "r.layer.1"), "linewidth", 1.35),
            _backend_patch(_object(baseline, "r.layer.2"), "outlier_color", "#DE2D26"),
            _backend_patch(_object(baseline, "r.layer.2"), "outlier_shape", 24),
            _backend_patch(_object(baseline, "r.layer.2"), "outlier_size", 3.2),
            _backend_patch(_object(baseline, "r.layer.3"), "facecolor", "#8C510A"),
            _backend_patch(_object(baseline, "r.layer.4"), "facecolor", "#8C510A"),
        ]
        styled = _run_r_renderer(script, style_edits)
        fill_group_objects = [
            obj for obj in styled["manifest"]["objects"]
            if obj["id"].startswith("r.group.fill.")
        ]
        fill_group_keys = [obj["currentProps"]["groupKey"] for obj in fill_group_objects]
        fill_group_ids = [obj["id"] for obj in fill_group_objects]
        fill_palette_ids = [
            group["paletteId"]
            for group in styled["manifest"]["groups"]
            if group.get("aesthetic") == "fill"
        ]
        fill_binding_ids = [
            binding["groupId"]
            for binding in styled["manifest"]["bindings"]
            if binding.get("groupId", "").startswith("r.group.fill.")
        ]
        fill_target_instance_keys = [
            target["instanceKey"]
            for binding in styled["manifest"]["bindings"]
            if binding.get("groupId", "").startswith("r.group.fill.")
            for target in binding.get("targets", [])
        ]
        self.assertEqual(len(fill_group_objects), len(set(fill_group_ids)))
        self.assertEqual(len(fill_group_objects), len(set(fill_group_keys)))
        self.assertEqual(len(fill_palette_ids), len(set(fill_palette_ids)))
        self.assertEqual(len(fill_binding_ids), len(set(fill_binding_ids)))
        self.assertEqual(len(fill_target_instance_keys), len(set(fill_target_instance_keys)))
        fill_groups = {obj["currentProps"]["groupKey"]: obj for obj in fill_group_objects}

        self.assertFalse(styled["conflict"])
        self.assertEqual(set(fill_groups), {"A", "B", "C", "D", "E", "F"})
        self.assertEqual(fill_groups["C"]["id"], "r.group.fill.0.2")
        self.assertEqual(fill_groups["D"]["id"], "r.group.fill.0.3")
        self.assertTrue(fill_groups["C"]["currentProps"]["scaleActive"])
        self.assertTrue(fill_groups["D"]["currentProps"]["scaleActive"])
        self.assertTrue(all(
            not fill_groups[key]["currentProps"]["scaleActive"]
            for key in ("A", "B", "E", "F")
        ))

        palette_edit = _backend_patch(fill_groups["C"], "facecolor", "#FB9A99")
        replayed = _run_r_renderer(script, [*style_edits, palette_edit])
        self.assertFalse(replayed["conflict"])
        self.assertIn("#fb9a99", replayed["svg"].lower())

    def test_ambiguous_duplicate_scale_group_keys_do_not_collapse_manifest_ids(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=c(1, 2, 3, 4), group=c("A", "A", "B", "B"))
p <- ggplot(df, aes(x=x, y=y, colour=group)) +
  geom_point(size=2.5) +
  scale_colour_manual(
    values=c("#1F78B4", "#33A02C", "#E31A1C"),
    limits=c("A", "A", "B")
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_color_objects = [
            obj for obj in baseline["manifest"]["objects"]
            if obj["id"].startswith("r.group.color.")
        ]
        duplicate_a_objects = [
            obj for obj in baseline_color_objects
            if obj["currentProps"]["groupKey"] == "A"
        ]
        self.assertEqual(len(duplicate_a_objects), 2)
        self.assertTrue(all(obj["currentProps"]["identityAmbiguous"] for obj in duplicate_a_objects))
        self.assertTrue(all(obj["editable"] == [] for obj in duplicate_a_objects))
        self.assertTrue(all(obj["propertyCapabilities"] == [] for obj in duplicate_a_objects))

        point_edit = _backend_patch(_object(baseline, "r.layer.0"), "size", 4.0)
        styled = _run_r_renderer(script, [point_edit])
        color_objects = [
            obj for obj in styled["manifest"]["objects"]
            if obj["id"].startswith("r.group.color.")
        ]
        group_keys = [obj["currentProps"]["groupKey"] for obj in color_objects]
        object_ids = [obj["id"] for obj in color_objects]
        palette_ids = [
            palette["id"] for palette in styled["manifest"]["palettes"]
            if palette["id"].startswith("r.scale.color.")
        ]
        binding_group_ids = [
            binding["groupId"] for binding in styled["manifest"]["bindings"]
            if binding.get("groupId", "").startswith("r.group.color.")
        ]
        target_instance_keys = [
            target["instanceKey"]
            for binding in styled["manifest"]["bindings"]
            if binding.get("groupId", "").startswith("r.group.color.")
            for target in binding.get("targets", [])
        ]

        self.assertFalse(styled["conflict"])
        self.assertEqual(_object(styled, "r.layer.0")["currentProps"]["size"], 4.0)
        self.assertGreaterEqual(group_keys.count("A"), 2)
        self.assertEqual(len(object_ids), len(set(object_ids)))
        self.assertEqual(len(palette_ids), len(set(palette_ids)))
        self.assertEqual(len(binding_group_ids), len(set(binding_group_ids)))
        self.assertEqual(len(target_instance_keys), len(set(target_instance_keys)))

        ambiguous_identity_edit = _backend_patch(duplicate_a_objects[0], "color", "#000000")
        rejected = _run_r_renderer(script, [ambiguous_identity_edit])
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(
            [obj["currentProps"]["color"] for obj in rejected["manifest"]["objects"] if obj["id"] in {item["id"] for item in duplicate_a_objects}],
            [obj["currentProps"]["color"] for obj in baseline_color_objects if obj["id"] in {item["id"] for item in duplicate_a_objects}],
        )
        self.assertTrue(any(
            warning.get("type") == "ambiguous_identity"
            for warning in rejected["warnings"]
            if isinstance(warning, dict)
        ))

        legacy_gid_only_edit = {
            "gid": duplicate_a_objects[0]["id"],
            "prop": "color",
            "value": "#000000",
            "mode": "backend_patch",
        }
        legacy_rejected = _run_r_renderer(script, [legacy_gid_only_edit])
        self.assertTrue(legacy_rejected["conflict"])
        self.assertEqual(legacy_rejected["applied"], [])
        self.assertEqual(
            [obj["currentProps"]["color"] for obj in legacy_rejected["manifest"]["objects"] if obj["id"] in {item["id"] for item in duplicate_a_objects}],
            [obj["currentProps"]["color"] for obj in baseline_color_objects if obj["id"] in {item["id"] for item in duplicate_a_objects}],
        )
        self.assertTrue(any(
            warning.get("type") == "unsupported_prop"
            for warning in legacy_rejected["warnings"]
            if isinstance(warning, dict)
        ))

    def test_shared_color_group_identity_survives_line_style_override(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(1:4, 2),
  y=c(1, 2, 3, 4, 1.4, 2.4, 3.4, 4.4),
  group=rep(c("A", "B"), each=4)
)
p <- ggplot(df, aes(x=x, y=y, colour=group)) +
  geom_point(size=2.5) +
  geom_line(linewidth=0.8) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_group = _object(baseline, "r.group.color.0.0")
        line = _object(baseline, "r.layer.1")
        style_edit = _backend_patch(line, "color", "#08519C")
        styled = _run_r_renderer(script, [style_edit])
        styled_group = _object(styled, "r.group.color.0.0")

        self.assertFalse(styled["conflict"])
        self.assertTrue(styled_group["currentProps"]["scaleActive"])
        self.assertEqual(styled_group["stableKey"], baseline_group["stableKey"])
        self.assertEqual(styled_group["fingerprint"], baseline_group["fingerprint"])
        self.assertEqual(styled_group["identity"], baseline_group["identity"])

        palette_edit = _backend_patch(styled_group, "color", "#2CA02C")
        replayed = _run_r_renderer(script, [style_edit, palette_edit])
        self.assertFalse(replayed["conflict"])
        self.assertIn("#2ca02c", replayed["svg"].lower())

    def test_ribbon_and_area_adapters_report_truthful_contract_and_replay_style(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=1:4,
  y=c(1, 3, 2, 4),
  ymin=c(0.7, 2.5, 1.6, 3.4),
  ymax=c(1.4, 3.5, 2.5, 4.7)
)
p <- ggplot(df, aes(x=x)) +
  geom_ribbon(
    aes(ymin=ymin, ymax=ymax),
    fill="#A6CEE3", colour="#1F78B4", linewidth=0.7, alpha=0.4
  ) +
  geom_area(
    aes(y=y),
    fill="#B2DF8A", colour="#33A02C", linewidth=0.5, alpha=0.5
  ) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        ribbon = _object(baseline, "r.layer.0")
        area = _object(baseline, "r.layer.1")
        edits = [
            _backend_patch(ribbon, "facecolor", "#FB9A99"),
            _backend_patch(ribbon, "edgecolor", "#E31A1C"),
            _backend_patch(ribbon, "linewidth", 1.25),
            _backend_patch(ribbon, "alpha", 0.6),
            _backend_patch(area, "facecolor", "#FDBF6F"),
            _backend_patch(area, "edgecolor", "#FF7F00"),
        ]
        result = _run_r_renderer(script, edits)
        rendered_ribbon = _object(result, "r.layer.0")
        rendered_area = _object(result, "r.layer.1")

        for obj, family, artist_class in (
            (ribbon, "ribbon", "GeomRibbon"),
            (area, "area", "GeomArea"),
        ):
            self.assertEqual(obj["kind"], "patch")
            self.assertEqual(obj["source"]["artistClass"], artist_class)
            self.assertEqual(obj["currentProps"]["adapterFamily"], family)
            self.assertEqual(obj["currentProps"]["componentRoles"], ["body", "boundary_lines"])
            self.assertEqual(set(obj["editable"]), {"facecolor", "edgecolor", "linewidth", "alpha"})
            self.assertNotIn("ymin", obj["editable"])
            self.assertNotIn("ymax", obj["editable"])
            self.assertNotIn("baseline", obj["editable"])

        self.assertFalse(result["conflict"])
        self.assertEqual(rendered_ribbon["currentProps"]["facecolor"], "#FB9A99")
        self.assertEqual(rendered_ribbon["currentProps"]["edgecolor"], "#E31A1C")
        self.assertEqual(rendered_ribbon["currentProps"]["linewidth"], 1.25)
        self.assertEqual(rendered_ribbon["currentProps"]["alpha"], 0.6)
        self.assertEqual(rendered_area["currentProps"]["facecolor"], "#FDBF6F")
        self.assertEqual(rendered_area["currentProps"]["edgecolor"], "#FF7F00")
        self.assertEqual(rendered_ribbon["stableKey"], ribbon["stableKey"])
        self.assertEqual(rendered_ribbon["fingerprint"], ribbon["fingerprint"])
        self.assertEqual(rendered_ribbon["identity"], ribbon["identity"])
        self.assertEqual(rendered_area["stableKey"], area["stableKey"])
        self.assertEqual(rendered_area["fingerprint"], area["fingerprint"])
        self.assertEqual(rendered_area["identity"], area["identity"])
        self.assertIn("#FB9A99".lower(), result["svg"].lower())
        self.assertIn("#E31A1C".lower(), result["svg"].lower())
        self.assertIn("#FDBF6F".lower(), result["svg"].lower())
        self.assertIn("#FF7F00".lower(), result["svg"].lower())

    def test_ribbon_full_outline_component_mismatch_does_not_consume_following_same_color_line(self):
        script = """
library(ggplot2)
band <- data.frame(
  x=1:4,
  ymin=c(1.0, 1.2, 1.1, 1.4),
  ymax=c(1.8, 2.1, 2.0, 2.3),
  group="A"
)
trend <- data.frame(x=1:4, y=c(2.5, 2.7, 2.6, 2.9))
p <- ggplot() +
  geom_ribbon(
    data=band,
    aes(x=x, ymin=ymin, ymax=ymax, fill=group, colour=group, group=group),
    outline.type="full", alpha=0.35, linewidth=0.7
  ) +
  geom_line(data=trend, aes(x=x, y=y), colour="#1F78B4", linewidth=0.9) +
  scale_colour_manual(values=c(A="#1F78B4")) +
  scale_fill_manual(values=c(A="#A6CEE3")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)

        self.assertIn('data-fig-id="r.layer.0"', result["svg"])
        self.assertEqual(result["svg"].count('data-fig-id="r.layer.1"'), 1)

    def test_ribbon_area_mapped_fill_groups_keep_band_semantics(self):
        script = """
library(ggplot2)
ribbon_df <- data.frame(
  x=rep(1:4, 2),
  ymin=c(0.6, 1.4, 1.1, 2.0, 1.4, 2.2, 1.7, 2.8),
  ymax=c(1.2, 2.1, 1.8, 2.8, 2.0, 3.0, 2.5, 3.6),
  group=rep(c("A", "B"), each=4)
)
area_df <- data.frame(
  x=rep(1:4, 2),
  y=c(0.7, 1.2, 1.0, 1.6, 1.1, 1.7, 1.4, 2.1),
  group=rep(c("A", "B"), each=4)
)
p <- ggplot() +
  geom_ribbon(
    data=ribbon_df,
    aes(x=x, ymin=ymin, ymax=ymax, group=group, fill=group),
    position="identity", alpha=0.35
  ) +
  geom_area(
    data=area_df,
    aes(x=x, y=y, group=group, fill=group),
    position="identity", alpha=0.2
  ) +
  scale_fill_manual(values=c(A="#80B1D3", B="#FDB462")) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        layer_zero = _object(result, "r.layer.0")
        layer_one = _object(result, "r.layer.1")
        fill_groups = [group for group in result["manifest"]["groups"] if group.get("aesthetic") == "fill"]

        self.assertEqual(layer_zero["currentProps"]["adapterFamily"], "ribbon")
        self.assertEqual(layer_one["currentProps"]["adapterFamily"], "area")
        self.assertTrue(layer_zero["currentProps"]["fillMapped"])
        self.assertTrue(layer_one["currentProps"]["fillMapped"])
        self.assertTrue(fill_groups)
        self.assertTrue(all(group["kind"] == "band" for group in fill_groups))
        self.assertTrue(all(set(group["geomFamilies"]) == {"GeomRibbon", "GeomArea"} for group in fill_groups))
        self.assertTrue(all(set(group["layerIds"]) == {"r.layer.0", "r.layer.1"} for group in fill_groups))
        self.assertTrue(all(group["groupId"] in layer_zero["identity"]["relation"]["groupIds"] for group in fill_groups))
        self.assertTrue(all(group["groupId"] in layer_one["identity"]["relation"]["groupIds"] for group in fill_groups))

    def test_band_style_edits_preserve_existing_fill_group_identity_for_later_palette_edits(self):
        script = """
library(ggplot2)
bars <- data.frame(x=1:4, y=c(1, 2, 1.5, 2.5), group=c("A", "A", "B", "B"))
band <- data.frame(
  x=rep(5:8, 2),
  ymin=c(0.6, 1.0, 0.8, 1.2, 1.1, 1.5, 1.3, 1.8),
  ymax=c(1.2, 1.7, 1.5, 2.0, 1.8, 2.3, 2.1, 2.7),
  group=rep(c("E", "F"), each=4)
)
area <- data.frame(
  x=rep(5:8, 2),
  y=c(0.5, 0.9, 0.7, 1.1, 1.0, 1.4, 1.2, 1.7),
  group=rep(c("E", "F"), each=4)
)
p <- ggplot() +
  geom_col(data=bars, aes(x=x, y=y, fill=group), width=0.5) +
  geom_ribbon(
    data=band,
    aes(x=x, ymin=ymin, ymax=ymax, group=group, fill=group),
    position="identity", alpha=0.3
  ) +
  geom_area(
    data=area,
    aes(x=x, y=y, group=group, fill=group),
    position="identity", alpha=0.2
  ) +
  scale_fill_manual(values=c(A="#80B1D3", B="#FDB462", E="#92C5DE", F="#A6D96A")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_group = _object(baseline, "r.group.fill.0.0")
        style_edits = [
            _backend_patch(_object(baseline, "r.layer.1"), "facecolor", "#8C510A"),
            _backend_patch(_object(baseline, "r.layer.2"), "facecolor", "#8C510A"),
        ]
        styled = _run_r_renderer(script, style_edits)
        styled_group = _object(styled, "r.group.fill.0.0")

        self.assertEqual(styled_group["stableKey"], baseline_group["stableKey"])
        self.assertEqual(styled_group["fingerprint"], baseline_group["fingerprint"])
        self.assertEqual(styled_group["identity"], baseline_group["identity"])

        palette_edit = _backend_patch(styled_group, "facecolor", "#FB9A99")
        replayed = _run_r_renderer(script, [*style_edits, palette_edit])
        self.assertFalse(replayed["conflict"])
        self.assertEqual(_object(replayed, "r.group.fill.0.0")["currentProps"]["facecolor"], "#FB9A99")
        self.assertIn("#FB9A99".lower(), replayed["svg"].lower())

        dormant_group = _object(styled, "r.group.fill.0.2")
        self.assertFalse(dormant_group["currentProps"]["scaleActive"])
        dormant_palette_edit = _backend_patch(dormant_group, "facecolor", "#FF00FF")
        rejected = _run_r_renderer(script, [*style_edits, dormant_palette_edit])
        self.assertTrue(rejected["conflict"])
        self.assertIn(dormant_palette_edit, rejected["skipped"])

        earlier_palette_edit = _backend_patch(_object(baseline, "r.group.fill.0.2"), "facecolor", "#FF00FF")
        rejected_reorder = _run_r_renderer(script, [earlier_palette_edit, *style_edits])
        self.assertTrue(rejected_reorder["conflict"])
        self.assertIn(earlier_palette_edit, rejected_reorder["skipped"])

    def test_geom_col_adapter_reports_inherited_fill_and_color_mapping_and_replays_style(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B", "C", "D"), value=c(2, 4, 3, 5), group=c("G1", "G1", "G2", "G2"))
p <- ggplot(df, aes(x, value, fill=group, colour=group)) +
  geom_col(linewidth=0.4, alpha=0.8) +
  scale_fill_manual(values=c(G1="#1F78B4", G2="#33A02C")) +
  scale_colour_manual(values=c(G1="#222222", G2="#444444")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_layer = _object(baseline, "r.layer.0")
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#FB9A99", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "edgecolor", "value": "#111111", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 1.3, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "alpha", "value": 0.45, "mode": "backend_patch"},
        ])
        layer = _object(result, "r.layer.0")

        self.assertEqual(baseline_layer["kind"], "patch")
        self.assertEqual(baseline_layer["currentProps"]["adapterFamily"], "bar")
        self.assertTrue(baseline_layer["currentProps"]["fillMapped"])
        self.assertTrue(baseline_layer["currentProps"]["colorMapped"])
        self.assertGreater(len(set(baseline_layer["currentProps"]["facecolorValues"])), 1)
        self.assertIn("facecolor", layer["editable"])
        self.assertIn("edgecolor", layer["editable"])
        self.assertEqual(layer["currentProps"]["facecolor"], "#FB9A99")
        self.assertEqual(layer["currentProps"]["edgecolor"], "#111111")
        self.assertEqual(layer["currentProps"]["linewidth"], 1.3)
        self.assertEqual(layer["currentProps"]["alpha"], 0.45)
        self.assertIn("#FB9A99".lower(), result["svg"].lower())
        self.assertIn("#111111".lower(), result["svg"].lower())

    def test_bar_adapter_keeps_legacy_gid_and_identity_stable_across_style_edits(self):
        script = """
library(ggplot2)
df <- data.frame(x=c("A", "B", "C"), value=c(2, 4, 3))
p <- ggplot(df, aes(x, value)) + geom_col(fill="#1F78B4", colour="#222222", linewidth=0.5) + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 1.4, "mode": "backend_patch"},
        ])
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["facecolor"], "#D62728")
        self.assertEqual(patched_layer["currentProps"]["linewidth"], 1.4)

    def test_geom_bar_stat_count_adapter_replays_style_and_keeps_identity_stable(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c("A", "A", "B", "B", "C", "C"),
  group=c("G1", "G2", "G1", "G1", "G2", "G2")
)
p <- ggplot(df, aes(x, fill=group)) +
  geom_bar(colour="#222222", linewidth=0.5, alpha=0.8) +
  scale_fill_manual(values=c(G1="#1F78B4", G2="#33A02C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "facecolor", "value": "#CAB2D6", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "edgecolor", "value": "#111111", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linewidth", "value": 1.2, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "alpha", "value": 0.5, "mode": "backend_patch"},
        ])
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertEqual(baseline_layer["currentProps"]["adapterFamily"], "bar")
        self.assertTrue(baseline_layer["currentProps"]["fillMapped"])
        self.assertEqual(baseline_layer["currentProps"]["positionClass"], "PositionStack")
        self.assertGreater(baseline_layer["currentProps"]["barCount"], 0)
        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["facecolor"], "#CAB2D6")
        self.assertEqual(patched_layer["currentProps"]["edgecolor"], "#111111")
        self.assertEqual(patched_layer["currentProps"]["linewidth"], 1.2)
        self.assertEqual(patched_layer["currentProps"]["alpha"], 0.5)
        self.assertIn("#CAB2D6".lower(), patched["svg"].lower())
        self.assertIn("#111111".lower(), patched["svg"].lower())

    def test_errorbar_family_adapter_reports_components_and_replays_supported_styles(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=1:3,
  y=c(2.2, 3.4, 2.9),
  ymin=c(1.7, 2.8, 2.3),
  ymax=c(2.8, 4.1, 3.6)
)
p <- ggplot(df, aes(x, y, ymin=ymin, ymax=ymax)) +
  geom_errorbar(width=0.2, colour="#444444", linewidth=0.6) +
  geom_linerange(colour="#D95F0E", linewidth=0.7) +
  geom_pointrange(colour="#1F78B4", fill="#A6CEE3", shape=21, size=2.5, linewidth=0.8) +
  geom_crossbar(width=0.3, colour="#222222", fill="#B2DF8A", linewidth=0.9) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        errorbar = _object(baseline, "r.layer.0")
        linerange = _object(baseline, "r.layer.1")
        pointrange = _object(baseline, "r.layer.2")
        crossbar = _object(baseline, "r.layer.3")

        self.assertEqual(errorbar["kind"], "errorbar_container")
        self.assertEqual(errorbar["identity"]["scope"], "subplot")
        self.assertEqual(errorbar["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertEqual(errorbar["currentProps"]["adapterFamily"], "errorbar")
        self.assertEqual(errorbar["currentProps"]["componentRoles"], ["interval_line", "caps"])
        self.assertTrue(errorbar["currentProps"]["hasCaps"])
        self.assertFalse(errorbar["currentProps"]["hasPoint"])
        self.assertEqual(errorbar["currentProps"]["capUnit"], "data")
        self.assertIn("elinewidth", errorbar["editable"])
        self.assertIn("capsize", errorbar["editable"])
        self.assertNotIn("marker", errorbar["editable"])

        self.assertEqual(linerange["currentProps"]["componentRoles"], ["interval_line"])
        self.assertEqual(linerange["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertFalse(linerange["currentProps"]["hasCaps"])
        self.assertNotIn("capsize", linerange["editable"])

        self.assertEqual(pointrange["currentProps"]["componentRoles"], ["interval_line", "point"])
        self.assertEqual(pointrange["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertTrue(pointrange["currentProps"]["hasPoint"])
        self.assertIn("marker", pointrange["editable"])
        self.assertIn("markersize", pointrange["editable"])

        self.assertEqual(crossbar["currentProps"]["componentRoles"], ["interval_line", "caps", "crossbar"])
        self.assertEqual(crossbar["identity"]["relation"]["subplotId"], "subplot.0")
        self.assertTrue(crossbar["currentProps"]["hasCrossbar"])
        self.assertIn("facecolor", crossbar["editable"])

        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "elinewidth", "value": 1.7, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "capsize", "value": 0.4, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "linestyle", "value": "dashed", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "alpha", "value": 0.5, "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "linewidth", "value": 1.4, "mode": "backend_patch"},
            {"gid": "r.layer.2", "prop": "marker", "value": 24, "mode": "backend_patch"},
            {"gid": "r.layer.2", "prop": "markersize", "value": 4.5, "mode": "backend_patch"},
            {"gid": "r.layer.3", "prop": "facecolor", "value": "#CAB2D6", "mode": "backend_patch"},
            {"gid": "r.layer.3", "prop": "capsize", "value": 0.45, "mode": "backend_patch"},
        ])
        patched_errorbar = _object(result, "r.layer.0")
        patched_linerange = _object(result, "r.layer.1")
        patched_pointrange = _object(result, "r.layer.2")
        patched_crossbar = _object(result, "r.layer.3")

        self.assertFalse(result["conflict"])
        self.assertEqual(patched_errorbar["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_errorbar["currentProps"]["elinewidth"], 1.7)
        self.assertEqual(patched_errorbar["currentProps"]["linewidth"], 1.7)
        self.assertAlmostEqual(patched_errorbar["currentProps"]["capsize"], 0.4)
        self.assertEqual(patched_errorbar["currentProps"]["linestyle"], "dashed")
        self.assertEqual(patched_errorbar["currentProps"]["alpha"], 0.5)
        self.assertEqual(patched_linerange["currentProps"]["elinewidth"], 1.4)
        self.assertEqual(patched_pointrange["currentProps"]["marker"], 24)
        self.assertEqual(patched_pointrange["currentProps"]["markersize"], 4.5)
        self.assertEqual(patched_crossbar["currentProps"]["facecolor"], "#CAB2D6")
        self.assertAlmostEqual(patched_crossbar["currentProps"]["capsize"], 0.45)
        self.assertIn("#D62728".lower(), result["svg"].lower())
        self.assertIn("#CAB2D6".lower(), result["svg"].lower())

    def test_errorbar_adapter_keeps_group_panel_identity_stable_across_style_edits(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c(1, 2, 1, 2),
  y=c(2.2, 3.4, 2.8, 3.7),
  ymin=c(1.8, 2.9, 2.4, 3.2),
  ymax=c(2.7, 3.9, 3.3, 4.2),
  group=rep(c("G1", "G2"), each=2)
)
p <- ggplot(df, aes(x, y, ymin=ymin, ymax=ymax, colour=group)) +
  geom_errorbar(width=0.18, linewidth=0.6, position=position_dodge(width=0.25)) +
  scale_colour_manual(values=c(G1="#1F78B4", G2="#33A02C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        patched = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "elinewidth", "value": 1.8, "mode": "backend_patch"},
            {"gid": "r.layer.0", "prop": "capsize", "value": 0.3, "mode": "backend_patch"},
        ])
        baseline_layer = _object(baseline, "r.layer.0")
        patched_layer = _object(patched, "r.layer.0")

        self.assertTrue(baseline_layer["currentProps"]["colorMapped"])
        self.assertEqual(baseline_layer["currentProps"]["positionClass"], "PositionDodge")
        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_layer["currentProps"]["elinewidth"], 1.8)
        self.assertAlmostEqual(patched_layer["currentProps"]["capsize"], 0.3)

    def test_step_adapter_reports_semantic_identity_groups_readonly_direction_and_replays_style(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=rep(1:4, 2),
  y=c(1, 3, 2, 5, 2, 4, 3, 6),
  group=rep(c("A", "B"), each=4)
)
p <- ggplot(df, aes(x, y, colour=group)) +
  geom_step(direction="vh", linewidth=0.8, linetype="dashed", alpha=0.7) +
  scale_colour_manual(values=c(A="#1F78B4", B="#33A02C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_layer = _object(baseline, "r.layer.0")
        color_groups = [obj for obj in _objects(baseline) if obj["id"].startswith("r.group.color.")]

        self.assertEqual(baseline_layer["kind"], "line")
        self.assertEqual(baseline_layer["role"], "ggplot_GeomStep")
        self.assertEqual(baseline_layer["source"]["artistClass"], "GeomStep")
        self.assertEqual(baseline_layer["source"]["adapterClass"], "GeomStep")
        self.assertEqual(baseline_layer["currentProps"]["adapterFamily"], "step")
        self.assertEqual(baseline_layer["currentProps"]["stepDirection"], "vh")
        self.assertTrue(baseline_layer["currentProps"]["colorMapped"])
        self.assertEqual(set(baseline_layer["editable"]), {"color", "linewidth", "linestyle", "alpha"})
        for readonly_prop in ("direction", "stepDirection"):
            self.assertNotIn(readonly_prop, baseline_layer["editable"])
            self.assertNotIn(readonly_prop, [item["prop"] for item in baseline_layer["propertyCapabilities"]])
        self.assertIn("GeomStep", baseline_layer["identity"]["semanticKey"])
        self.assertIn("GeomStep", baseline_layer["identity"]["relation"]["layerKey"])
        self.assertEqual(
            set(baseline_layer["identity"]["relation"]["groupIds"]),
            {group["id"] for group in color_groups},
        )
        self.assertEqual(len(color_groups), 2)
        for group in color_groups:
            relation = group["identity"]["relation"]
            self.assertEqual(group["kind"], "line")
            self.assertEqual(group["currentProps"]["semanticKind"], "line")
            self.assertEqual(group["currentProps"]["geomFamilies"], ["GeomStep"])
            self.assertEqual(relation["layerId"], "r.layer.0")
            self.assertEqual(relation["layerIds"], ["r.layer.0"])
            self.assertTrue(relation["scaleKey"].startswith("ggplot-scale:color:group:"))
            self.assertTrue(relation["guideKey"].startswith("ggplot-guide:group:"))

        patched = _run_r_renderer(script, [
            _backend_patch(baseline_layer, "color", "#D62728"),
            _backend_patch(baseline_layer, "linewidth", 1.9),
            _backend_patch(baseline_layer, "linestyle", "solid"),
            _backend_patch(baseline_layer, "alpha", 0.45),
        ])
        patched_layer = _object(patched, "r.layer.0")

        self.assertFalse(patched["conflict"])
        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_layer["currentProps"]["linewidth"], 1.9)
        self.assertEqual(patched_layer["currentProps"]["linestyle"], "solid")
        self.assertEqual(patched_layer["currentProps"]["alpha"], 0.45)
        self.assertIn("#D62728".lower(), patched["svg"].lower())

    def test_histogram_adapter_reports_stat_bin_structure_groups_and_legacy_layer_replay(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c(1.1, 1.2, 1.8, 2.2, 2.4, 3.1, 3.3, 3.7),
  group=rep(c("A", "B"), 4)
)
p <- ggplot(df, aes(x, fill=group, colour=group)) +
  geom_histogram(binwidth=1, boundary=1, linewidth=0.4, alpha=0.65, position="identity") +
  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99")) +
  scale_colour_manual(values=c(A="#1F78B4", B="#E31A1C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_layer = _object(baseline, "r.layer.0")
        fill_groups = [obj for obj in _objects(baseline) if obj["id"].startswith("r.group.fill.")]
        color_groups = [obj for obj in _objects(baseline) if obj["id"].startswith("r.group.color.")]

        self.assertEqual(baseline_layer["kind"], "patch")
        self.assertEqual(baseline_layer["role"], "ggplot_GeomBar")
        self.assertEqual(baseline_layer["source"]["artistClass"], "GeomBar")
        self.assertEqual(baseline_layer["source"]["adapterClass"], "GeomHistogram")
        self.assertEqual(baseline_layer["currentProps"]["adapterFamily"], "histogram")
        self.assertTrue(baseline_layer["currentProps"]["fillMapped"])
        self.assertTrue(baseline_layer["currentProps"]["colorMapped"])
        self.assertEqual(baseline_layer["currentProps"]["binwidth"], 1)
        self.assertGreater(len(baseline_layer["currentProps"]["breaks"]), 1)
        self.assertGreater(len(baseline_layer["currentProps"]["counts"]), 0)
        self.assertGreater(len(baseline_layer["currentProps"]["density"]), 0)
        self.assertEqual(sum(baseline_layer["currentProps"]["counts"]), 8)
        self.assertEqual(set(baseline_layer["editable"]), {"facecolor", "edgecolor", "linewidth", "alpha"})
        for readonly_prop in ("binwidth", "breaks", "bins", "counts", "density"):
            self.assertNotIn(readonly_prop, baseline_layer["editable"])
            self.assertNotIn(readonly_prop, [item["prop"] for item in baseline_layer["propertyCapabilities"]])
        self.assertIn("ggplot_GeomBar", baseline_layer["identity"]["semanticKey"])
        self.assertIn("GeomBar:StatBin", baseline_layer["identity"]["relation"]["layerKey"])
        self.assertEqual(
            set(baseline_layer["identity"]["relation"]["groupIds"]),
            {group["id"] for group in [*fill_groups, *color_groups]},
        )
        self.assertEqual(len(fill_groups), 2)
        self.assertEqual(len(color_groups), 2)
        for group in [*fill_groups, *color_groups]:
            relation = group["identity"]["relation"]
            self.assertEqual(group["currentProps"]["geomFamilies"], ["GeomBar"])
            self.assertEqual(relation["layerId"], "r.layer.0")
            self.assertEqual(relation["layerIds"], ["r.layer.0"])
            self.assertTrue(relation["scaleKey"].startswith(f"ggplot-scale:{relation['aesthetic']}:group:"))
            self.assertTrue(relation["guideKey"].startswith("ggplot-guide:group:"))

        patched = _run_r_renderer(script, [
            _backend_patch(baseline_layer, "facecolor", "#CAB2D6"),
            _backend_patch(baseline_layer, "edgecolor", "#111111"),
            _backend_patch(baseline_layer, "linewidth", 1.2),
            _backend_patch(baseline_layer, "alpha", 0.5),
        ])
        patched_layer = _object(patched, "r.layer.0")

        self.assertFalse(patched["conflict"])
        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["facecolor"], "#CAB2D6")
        self.assertEqual(patched_layer["currentProps"]["edgecolor"], "#111111")
        self.assertEqual(patched_layer["currentProps"]["linewidth"], 1.2)
        self.assertEqual(patched_layer["currentProps"]["alpha"], 0.5)
        self.assertIn("#CAB2D6".lower(), patched["svg"].lower())
        self.assertIn("#111111".lower(), patched["svg"].lower())

    def test_freqpoly_adapter_reports_stat_bin_structure_groups_and_legacy_layer_replay(self):
        script = """
library(ggplot2)
df <- data.frame(
  x=c(1.1, 1.2, 1.8, 2.2, 2.4, 3.1, 3.3, 3.7),
  group=rep(c("A", "B"), 4)
)
p <- ggplot(df, aes(x, y=after_stat(density), colour=group)) +
  geom_freqpoly(bins=4, boundary=1, linewidth=0.7, linetype="dashed", alpha=0.8) +
  scale_colour_manual(values=c(A="#1F78B4", B="#33A02C")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        baseline_layer = _object(baseline, "r.layer.0")
        color_groups = [obj for obj in _objects(baseline) if obj["id"].startswith("r.group.color.")]

        self.assertEqual(baseline_layer["kind"], "line")
        self.assertEqual(baseline_layer["role"], "ggplot_GeomPath")
        self.assertEqual(baseline_layer["source"]["artistClass"], "GeomPath")
        self.assertEqual(baseline_layer["source"]["adapterClass"], "GeomFreqpoly")
        self.assertEqual(baseline_layer["currentProps"]["adapterFamily"], "freqpoly")
        self.assertTrue(baseline_layer["currentProps"]["colorMapped"])
        self.assertEqual(baseline_layer["currentProps"]["bins"], 4)
        self.assertEqual(baseline_layer["currentProps"]["yStat"], "density")
        self.assertGreater(len(baseline_layer["currentProps"]["breaks"]), 1)
        self.assertGreater(len(baseline_layer["currentProps"]["counts"]), 0)
        self.assertGreater(len(baseline_layer["currentProps"]["density"]), 0)
        self.assertEqual(sum(baseline_layer["currentProps"]["counts"]), 8)
        self.assertEqual(set(baseline_layer["editable"]), {"color", "linewidth", "linestyle", "alpha"})
        for readonly_prop in ("binwidth", "breaks", "bins", "counts", "density", "yStat"):
            self.assertNotIn(readonly_prop, baseline_layer["editable"])
            self.assertNotIn(readonly_prop, [item["prop"] for item in baseline_layer["propertyCapabilities"]])
        self.assertIn("ggplot_GeomPath", baseline_layer["identity"]["semanticKey"])
        self.assertIn("GeomPath:StatBin", baseline_layer["identity"]["relation"]["layerKey"])
        self.assertEqual(
            set(baseline_layer["identity"]["relation"]["groupIds"]),
            {group["id"] for group in color_groups},
        )
        self.assertEqual(len(color_groups), 2)
        for group in color_groups:
            relation = group["identity"]["relation"]
            self.assertEqual(group["kind"], "line")
            self.assertEqual(group["currentProps"]["semanticKind"], "line")
            self.assertEqual(group["currentProps"]["geomFamilies"], ["GeomPath"])
            self.assertEqual(relation["layerId"], "r.layer.0")
            self.assertEqual(relation["layerIds"], ["r.layer.0"])
            self.assertTrue(relation["scaleKey"].startswith("ggplot-scale:color:group:"))
            self.assertTrue(relation["guideKey"].startswith("ggplot-guide:group:"))

        patched = _run_r_renderer(script, [
            _backend_patch(baseline_layer, "color", "#D62728"),
            _backend_patch(baseline_layer, "linewidth", 1.6),
            _backend_patch(baseline_layer, "linestyle", "solid"),
            _backend_patch(baseline_layer, "alpha", 0.45),
        ])
        patched_layer = _object(patched, "r.layer.0")

        self.assertFalse(patched["conflict"])
        self.assertEqual(patched["applied"][0]["gid"], "r.layer.0")
        self.assertEqual(baseline_layer["stableKey"], patched_layer["stableKey"])
        self.assertEqual(baseline_layer["fingerprint"], patched_layer["fingerprint"])
        self.assertEqual(baseline_layer["identity"], patched_layer["identity"])
        self.assertEqual(patched_layer["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_layer["currentProps"]["linewidth"], 1.6)
        self.assertEqual(patched_layer["currentProps"]["linestyle"], "solid")
        self.assertEqual(patched_layer["currentProps"]["alpha"], 0.45)
        self.assertIn("#D62728".lower(), patched["svg"].lower())

    def test_step_histogram_and_freqpoly_structural_props_are_rejected(self):
        script = """
library(ggplot2)
step_df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
bin_df <- data.frame(x=c(1.1, 1.2, 1.8, 2.2, 2.4, 3.1, 3.3, 3.7))
p <- ggplot() +
  geom_step(data=step_df, aes(x, y), direction="vh") +
  geom_histogram(data=bin_df, aes(x), binwidth=1, boundary=1) +
  geom_freqpoly(data=bin_df, aes(x), bins=4, boundary=1) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        step = _object(baseline, "r.layer.0")
        histogram = _object(baseline, "r.layer.1")
        freqpoly = _object(baseline, "r.layer.2")
        result = _run_r_renderer(script, [
            _backend_patch(step, "stepDirection", "hv"),
            _backend_patch(histogram, "binwidth", 2),
            _backend_patch(freqpoly, "bins", 8),
        ])

        self.assertTrue(result["conflict"])
        self.assertEqual(result["applied"], [])
        self.assertEqual(len(result["skipped"]), 3)
        self.assertTrue(all(
            warning.get("type") == "unsupported_prop"
            for warning in result["warnings"]
            if isinstance(warning, dict)
        ))
        self.assertEqual(_object(result, "r.layer.0")["currentProps"]["stepDirection"], "vh")
        self.assertEqual(_object(result, "r.layer.1")["currentProps"]["binwidth"], 1)
        self.assertEqual(_object(result, "r.layer.2")["currentProps"]["bins"], 4)

    def test_step_histogram_and_freqpoly_accept_legacy_gid_only_style_entries(self):
        script = """
library(ggplot2)
step_df <- data.frame(x=1:4, y=c(1, 3, 2, 5))
bin_df <- data.frame(x=c(1.1, 1.2, 1.8, 2.2, 2.4, 3.1, 3.3, 3.7))
p <- ggplot() +
  geom_step(data=step_df, aes(x, y), colour="#1F78B4", linewidth=0.7) +
  geom_histogram(data=bin_df, aes(x), binwidth=1, boundary=1, fill="#A6CEE3") +
  geom_freqpoly(data=bin_df, aes(x), bins=4, boundary=1, colour="#33A02C") +
  theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "r.layer.0", "prop": "color", "value": "#D62728", "mode": "backend_patch"},
            {"gid": "r.layer.1", "prop": "facecolor", "value": "#CAB2D6", "mode": "backend_patch"},
            {"gid": "r.layer.2", "prop": "linewidth", "value": 1.8, "mode": "backend_patch"},
        ])

        self.assertFalse(result["conflict"])
        self.assertEqual([entry["gid"] for entry in result["applied"]], ["r.layer.0", "r.layer.1", "r.layer.2"])
        self.assertEqual(_object(result, "r.layer.0")["currentProps"]["color"], "#D62728")
        self.assertEqual(_object(result, "r.layer.1")["currentProps"]["facecolor"], "#CAB2D6")
        self.assertEqual(_object(result, "r.layer.2")["currentProps"]["linewidth"], 1.8)

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
            {"gid": "r.facet.layout.0", "prop": "aspect", "value": "1", "mode": "backend_patch"},
        ])
        subplots = [obj for obj in _objects(result) if obj["kind"] == "subplot"]
        self.assertEqual(len(subplots), 2)
        self.assertNotIn("aspect", subplots[0]["editable"])
        self.assertEqual(subplots[0]["currentProps"]["aspect"], 1)
        self.assertEqual(subplots[1]["currentProps"]["aspect"], 1)
        facet_layout = _object(result, "r.facet.layout.0")
        self.assertIn("aspect", facet_layout["editable"])
        self.assertEqual(facet_layout["currentProps"]["aspect"], 1)
        self.assertIn("left", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("width", subplots[0]["currentProps"]["unsupportedProps"])
        self.assertIn("#2CA02C".lower(), result["svg"].lower())
        self.assertEqual(_object(result, "facet.strip.0")["currentProps"]["fontsize"], 16)

    def test_legacy_facet_panel_aspect_patch_migrates_to_layout(self):
        script = """
library(ggplot2)
df <- data.frame(x=1:4, y=1:4, facet=rep(c("F1", "F2"), each=2))
p <- ggplot(df, aes(x, y)) + geom_point() + facet_wrap(~facet) + theme_classic()
p
"""
        result = _run_r_renderer(script, [
            {"gid": "subplot.1", "prop": "aspect", "value": 1.25, "mode": "backend_patch"},
        ])

        self.assertFalse(result["conflict"])
        self.assertEqual(result["applied"][0]["gid"], "subplot.1")
        self.assertEqual(result["applied"][0]["resolvedGid"], "r.facet.layout.0")
        self.assertEqual(_object(result, "r.facet.layout.0")["currentProps"]["aspect"], 1.25)
        self.assertTrue(any(warning.get("type") == "legacy_target_alias" for warning in result["warnings"] if isinstance(warning, dict)))

    def test_facet_non_first_panel_tick_edits_stay_isolated_from_global_axis_theme(self):
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
        self.assertEqual(axis_x["currentProps"]["tick_labelsize"], 9)
        self.assertEqual(axis_x["currentProps"]["tick_labelfamily"], "")
        self.assertEqual(axis_x["currentProps"]["tick_labelcolor"], "black")
        self.assertEqual(axis_x["currentProps"]["tick_rotation"], 30)
        self.assertEqual(axis_x["currentProps"]["tick_direction"], "in")

    def test_tile_raster_rect_adapters_expose_mappable_relations_and_safe_layer_styles(self):
        cases = [
            ("GeomTile", 'geom_tile(colour="#111111", linewidth=0.4, alpha=0.8)', True),
            ("GeomRaster", "geom_raster(alpha=0.8)", False),
            ("GeomRect", 'geom_rect(aes(xmin=x-0.45, xmax=x+0.45, ymin=y-0.45, ymax=y+0.45), colour="#111111", linewidth=0.4, alpha=0.8)', True),
        ]

        for geom_name, geom_call, has_edge_style in cases:
            with self.subTest(geom=geom_name):
                script = f"""
library(ggplot2)
df <- expand.grid(x=1:4, y=1:3)
df$value <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x=x, y=y, fill=value)) +
  {geom_call} +
  scale_fill_gradient(low="#132B43", high="#56B1F7", limits=c(0, 2), name="Intensity") +
  theme_classic()
p
"""
                baseline = _run_r_renderer(script)
                layer = _object(baseline, "r.layer.0")
                heatmap = _object(baseline, "r.heatmap.fill.0")
                colorbar = _object(baseline, "r.colorbar.fill.0")

                self.assertEqual(layer["kind"], "patch")
                self.assertEqual(layer["role"], f"ggplot_{geom_name}")
                self.assertEqual(layer["source"]["artistClass"], geom_name)
                self.assertEqual(layer["source"]["adapterClass"], geom_name)
                self.assertEqual(layer["currentProps"]["adapterFamily"], geom_name[4:].lower())
                self.assertTrue(layer["currentProps"]["fillMapped"])
                self.assertTrue(layer["currentProps"]["scaleControlled"])
                self.assertNotEqual(layer["currentProps"]["facecolor"], "#1F77B4")
                self.assertNotIn("facecolor", layer["editable"])
                self.assertIn("alpha", layer["editable"])
                if has_edge_style:
                    self.assertIn("edgecolor", layer["editable"])
                    self.assertIn("linewidth", layer["editable"])
                else:
                    self.assertNotIn("edgecolor", layer["editable"])
                    self.assertNotIn("linewidth", layer["editable"])

                layer_relation = layer["identity"]["relation"]
                heatmap_relation = heatmap["identity"]["relation"]
                colorbar_relation = colorbar["identity"]["relation"]
                self.assertEqual(layer_relation["scaleId"], heatmap_relation["scaleId"])
                self.assertEqual(layer_relation["guideId"], colorbar["id"])
                self.assertEqual(layer_relation["colorbarId"], colorbar["id"])
                self.assertEqual(heatmap_relation["layerIds"], ["r.layer.0"])
                self.assertEqual(colorbar_relation["mappableId"], heatmap["id"])
                self.assertEqual(colorbar_relation["layerIds"], ["r.layer.0"])
                self.assertEqual(layer["identity"]["relation"]["subplotIds"], ["subplot.0"])

                edits = [_backend_patch(layer, "alpha", 0.35)]
                if has_edge_style:
                    edits.extend([
                        _backend_patch(layer, "edgecolor", "#AA00AA"),
                        _backend_patch(layer, "linewidth", 1.6),
                    ])
                patched = _run_r_renderer(script, edits)
                patched_layer = _object(patched, "r.layer.0")
                self.assertFalse(patched["conflict"])
                self.assertEqual(len(patched["applied"]), len(edits))
                self.assertEqual(patched_layer["currentProps"]["alpha"], 0.35)
                self.assertEqual(layer["stableKey"], patched_layer["stableKey"])
                self.assertEqual(layer["fingerprint"], patched_layer["fingerprint"])
                self.assertEqual(layer["identity"], patched_layer["identity"])

    def test_tile_adapter_replays_legacy_gid_only_and_pre_v2_fingerprint_entries(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:4, y=1:3)
df$value <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x=x, y=y, fill=value)) +
  geom_tile(colour="#111111", linewidth=0.4, alpha=0.8) +
  scale_fill_gradient(low="#132B43", high="#56B1F7", limits=c(0, 2), name="Intensity") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        layer = _object(baseline, "r.layer.0")
        legacy_gid_only = {
            "gid": layer["id"],
            "prop": "alpha",
            "value": 0.45,
            "mode": "backend_patch",
        }
        legacy_pre_v2_fingerprint = {
            "gid": layer["id"],
            "prop": "edgecolor",
            "value": "#AA00AA",
            "mode": "backend_patch",
            "stableKey": layer["stableKey"],
            "fingerprint": "legacy-style-sensitive-fingerprint",
            "identity": layer["identity"],
        }

        replayed = _run_r_renderer(script, [legacy_gid_only, legacy_pre_v2_fingerprint])
        replayed_layer = _object(replayed, layer["id"])
        self.assertFalse(replayed["conflict"])
        self.assertEqual(replayed["skipped"], [])
        self.assertEqual(len(replayed["applied"]), 2)
        self.assertEqual(replayed_layer["currentProps"]["alpha"], 0.45)
        self.assertEqual(replayed_layer["currentProps"]["edgecolor"], "#AA00AA")
        self.assertEqual(replayed_layer["stableKey"], layer["stableKey"])
        self.assertEqual(replayed_layer["fingerprint"], layer["fingerprint"])

    def test_mapped_edge_colour_remains_scale_owned_for_tile_rect_and_contourf(self):
        cases = [
            (
                "GeomTile",
                """
library(ggplot2)
df <- expand.grid(x=1:4, y=1:3)
df$value <- seq_len(nrow(df)) / 10
p <- ggplot(df, aes(x=x, y=y)) +
  geom_tile(aes(colour=value), fill="#C7E9C0", linewidth=0.35) +
  scale_colour_gradient(low="#132B43", high="#56B1F7", name="Tile edge") +
  theme_classic()
p
""",
            ),
            (
                "GeomRect",
                """
library(ggplot2)
df <- data.frame(
  xmin=c(0.5, 1.5, 2.5), xmax=c(1.5, 2.5, 3.5),
  ymin=c(0.5, 0.5, 0.5), ymax=c(1.5, 1.5, 1.5),
  value=c(0.2, 0.6, 1.0)
)
p <- ggplot(df) +
  geom_rect(aes(xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax, colour=value), fill="#FDAE6B", linewidth=0.35) +
  scale_colour_gradient(low="#132B43", high="#56B1F7", name="Rect edge") +
  theme_classic()
p
""",
            ),
            (
                "GeomContourFilled",
                """
library(ggplot2)
df <- expand.grid(x=seq(-2, 2, length.out=15), y=seq(-2, 2, length.out=15))
df$z <- with(df, x^2 + y^2)
p <- ggplot(df, aes(x=x, y=y, z=z)) +
  geom_contour_filled(aes(colour=after_stat(level_mid)), bins=5, fill="#CBC9E2", linewidth=0.3) +
  scale_colour_viridis_c(name="Contour edge") +
  theme_classic()
p
""",
            ),
        ]

        for geom_name, script in cases:
            with self.subTest(geom=geom_name):
                baseline = _run_r_renderer(script)
                layer = _object(baseline, "r.layer.0")
                self.assertEqual(layer["source"]["adapterClass"], geom_name)
                self.assertTrue(layer["currentProps"]["colorMapped"])
                self.assertNotIn("edgecolor", layer["editable"])
                self.assertFalse(any(
                    capability.get("prop") == "edgecolor"
                    for capability in layer["propertyCapabilities"]
                ))
                self.assertIn("scaleId", layer["identity"]["relation"])
                self.assertIn("colorbarId", layer["identity"]["relation"])

                rejected = _run_r_renderer(script, [
                    _backend_patch(layer, "edgecolor", "#AA00AA"),
                ])
                rejected_layer = _object(rejected, "r.layer.0")
                self.assertTrue(rejected["conflict"])
                self.assertEqual(rejected["applied"], [])
                self.assertEqual(len(rejected["skipped"]), 1)
                self.assertEqual(rejected_layer["currentProps"]["edgecolor"], layer["currentProps"]["edgecolor"])
                self.assertEqual(rejected_layer["stableKey"], layer["stableKey"])
                self.assertEqual(rejected_layer["fingerprint"], layer["fingerprint"])
                self.assertEqual(rejected_layer["identity"], layer["identity"])
                self.assertNotIn("#aa00aa", rejected["svg"].lower())

    def test_contour_and_contourf_adapters_keep_structure_readonly_and_replay_styles(self):
        script = """
library(ggplot2)
df <- expand.grid(x=seq(-2, 2, length.out=15), y=seq(-2, 2, length.out=15))
df$z <- with(df, x^2 + y^2)
p <- ggplot(df, aes(x=x, y=y, z=z)) +
  geom_contour(colour="#1F78B4", linewidth=0.7, linetype="dashed", bins=5) +
  geom_contour_filled(bins=5, alpha=0.65) +
  scale_fill_viridis_d() +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        contour = _object(baseline, "r.layer.0")
        contourf = _object(baseline, "r.layer.1")

        self.assertEqual(contour["kind"], "contour")
        self.assertEqual(contour["role"], "ggplot_GeomContour")
        self.assertEqual(contour["source"]["adapterClass"], "GeomContour")
        self.assertEqual(contourf["kind"], "contourf")
        self.assertEqual(contourf["role"], "ggplot_GeomContourFilled")
        self.assertEqual(contourf["source"]["adapterClass"], "GeomContourFilled")
        self.assertEqual(contour["currentProps"]["adapterFamily"], "contour")
        self.assertEqual(contourf["currentProps"]["adapterFamily"], "contourf")
        self.assertTrue(contour["currentProps"]["levels"])
        self.assertTrue(contourf["currentProps"]["levels"])
        self.assertTrue(contourf["currentProps"]["fillMapped"])
        self.assertIn("color", contour["editable"])
        self.assertIn("linewidth", contour["editable"])
        self.assertIn("linestyle", contour["editable"])
        self.assertIn("edgecolor", contourf["editable"])
        self.assertIn("linewidth", contourf["editable"])
        self.assertNotIn("levels", contour["editable"])
        self.assertNotIn("x", contour["editable"])
        self.assertNotIn("y", contour["editable"])
        self.assertNotIn("z", contour["editable"])
        self.assertNotIn("levels", contourf["editable"])
        self.assertNotIn("x", contourf["editable"])
        self.assertNotIn("y", contourf["editable"])
        self.assertNotIn("z", contourf["editable"])

        patched = _run_r_renderer(script, [
            _backend_patch(contour, "color", "#D62728"),
            _backend_patch(contour, "linewidth", 1.8),
            _backend_patch(contour, "linestyle", "solid"),
            _backend_patch(contourf, "edgecolor", "#111111"),
            _backend_patch(contourf, "linewidth", 1.2),
            _backend_patch(contourf, "alpha", 0.4),
        ])
        patched_contour = _object(patched, "r.layer.0")
        patched_contourf = _object(patched, "r.layer.1")
        self.assertFalse(patched["conflict"])
        self.assertEqual(len(patched["applied"]), 6)
        self.assertEqual(patched_contour["currentProps"]["color"], "#D62728")
        self.assertEqual(patched_contour["currentProps"]["linewidth"], 1.8)
        self.assertEqual(patched_contour["currentProps"]["linestyle"], "solid")
        self.assertEqual(patched_contourf["currentProps"]["edgecolor"], "#111111")
        self.assertEqual(patched_contourf["currentProps"]["linewidth"], 1.2)
        self.assertEqual(patched_contourf["currentProps"]["alpha"], 0.4)
        self.assertEqual(contour["identity"], patched_contour["identity"])
        self.assertEqual(contourf["identity"], patched_contourf["identity"])
        self.assertIn("#D62728".lower(), patched["svg"].lower())
        self.assertIn("#111111".lower(), patched["svg"].lower())

        rejected = _run_r_renderer(script, [
            _backend_patch(contour, "levels", [1, 2, 3]),
            _backend_patch(contourf, "z", [1, 2, 3]),
        ])
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])
        self.assertEqual(len(rejected["skipped"]), 2)
        self.assertEqual(_object(rejected, "r.layer.0")["currentProps"]["levels"], contour["currentProps"]["levels"])
        self.assertEqual(_object(rejected, "r.layer.1")["currentProps"]["levels"], contourf["currentProps"]["levels"])

    def test_contour_continuous_mappable_scale_replays_from_layer_and_keeps_colorbar_relation(self):
        script = """
library(ggplot2)
df <- expand.grid(x=seq(-2, 2, length.out=15), y=seq(-2, 2, length.out=15))
df$z <- with(df, x^2 + y^2)
p <- ggplot(df, aes(x=x, y=y, z=z)) +
  geom_contour(aes(colour=after_stat(level)), bins=5, linewidth=0.7) +
  scale_colour_viridis_c(name="Contour level") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        contour = _object(baseline, "r.layer.0")
        colorbar = _object(baseline, "r.colorbar.color.0")
        self.assertEqual(contour["kind"], "contour")
        self.assertTrue(contour["currentProps"]["colorMapped"])
        self.assertTrue(contour["currentProps"]["scaleControlled"])
        self.assertEqual(contour["identity"]["relation"]["scaleId"], "r.scale.color.continuous.0")
        self.assertEqual(contour["identity"]["relation"]["colorbarId"], colorbar["id"])
        self.assertEqual(colorbar["identity"]["relation"]["mappableId"], contour["id"])
        self.assertTrue(all(prop in contour["editable"] for prop in ("cmap", "vmin", "vmax")))

        patched = _run_r_renderer(script, [
            _backend_patch(contour, "cmap", "plasma"),
            _backend_patch(contour, "vmin", 0.5),
            _backend_patch(contour, "vmax", 6.5),
        ])
        patched_contour = _object(patched, "r.layer.0")
        patched_colorbar = _object(patched, "r.colorbar.color.0")
        self.assertFalse(patched["conflict"])
        self.assertEqual(len(patched["applied"]), 3)
        self.assertEqual(patched_contour["currentProps"]["cmap"], "plasma")
        self.assertAlmostEqual(patched_contour["currentProps"]["vmin"], 0.5)
        self.assertAlmostEqual(patched_contour["currentProps"]["vmax"], 6.5)
        self.assertEqual(patched_colorbar["currentProps"]["cmap"], "plasma")
        self.assertAlmostEqual(patched_colorbar["currentProps"]["vmin"], 0.5)
        self.assertAlmostEqual(patched_colorbar["currentProps"]["vmax"], 6.5)
        self.assertEqual(contour["stableKey"], patched_contour["stableKey"])
        self.assertEqual(contour["fingerprint"], patched_contour["fingerprint"])
        self.assertEqual(contour["identity"], patched_contour["identity"])

    def test_contour_function_breaks_are_readonly_and_json_safe(self):
        script = """
library(ggplot2)
df <- expand.grid(x=seq(-2, 2, length.out=15), y=seq(-2, 2, length.out=15))
df$z <- with(df, x^2 + y^2)
p <- ggplot(df, aes(x=x, y=y, z=z)) +
  geom_contour(breaks=function(x) pretty(x, n=4)) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        contour = _object(result, "r.layer.0")
        self.assertIsInstance(contour["currentProps"]["breaks"], str)
        self.assertIn("function", contour["currentProps"]["breaks"])
        self.assertNotIn("breaks", contour["editable"])
        self.assertFalse(any(
            capability.get("prop") == "breaks"
            for capability in contour["propertyCapabilities"]
        ))

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

    def test_faceted_continuous_fill_uses_one_shared_colorbar_for_all_owner_panels(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:3, y=1:2, facet=c("F1", "F2"))
df$value <- seq(0, 1, length.out=nrow(df))
p <- ggplot(df, aes(x, y, fill=value)) +
  geom_tile() +
  facet_wrap(~facet) +
  scale_fill_gradient(low="#132B43", high="#56B1F7", name="Intensity") +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        colorbars = [obj for obj in _objects(result) if obj.get("kind") == "colorbar"]
        panels = [obj for obj in _objects(result) if obj.get("role") == "ggplot_facet_panel"]

        self.assertEqual([obj["id"] for obj in colorbars], ["r.colorbar.fill.0"])
        colorbar_relation = colorbars[0]["identity"]["relation"]
        scale_relation = _object(result, "r.scale.fill.continuous.0")["identity"]["relation"]
        heatmap_relation = _object(result, "r.heatmap.fill.0")["identity"]["relation"]
        self.assertEqual(colorbar_relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertEqual(colorbar_relation["layerIds"], ["r.layer.0"])
        self.assertEqual(colorbar_relation["mappableIds"], ["r.heatmap.fill.0"])
        self.assertEqual(colorbar_relation["scaleId"], "r.scale.fill.continuous.0")
        self.assertEqual(colorbar_relation["guideId"], "r.colorbar.fill.0")
        self.assertEqual(scale_relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertEqual(heatmap_relation["subplotIds"], ["subplot.0", "subplot.1"])
        self.assertEqual(
            {panel["identity"]["relation"]["facetKey"] for panel in panels},
            {"facet=F1", "facet=F2"},
        )

    def test_legacy_absolute_continuous_scale_ids_remap_to_per_aesthetic_ids(self):
        script = """
library(ggplot2)
df <- expand.grid(x=1:3, y=1:3)
df$colour_value <- seq(0, 1, length.out=nrow(df))
df$fill_value <- rev(df$colour_value)
p <- ggplot(df, aes(x, y, colour=colour_value, fill=fill_value)) +
  geom_tile(linewidth=1) +
  scale_colour_gradient(low="#132B43", high="#56B1F7", name="Outline") +
  scale_fill_gradient(low="#FDE725", high="#440154", name="Fill") +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        self.assertEqual(_object(baseline, "r.colorbar.color.0")["currentProps"]["sourceScaleIndex"], 0)
        self.assertEqual(_object(baseline, "r.colorbar.fill.0")["currentProps"]["sourceScaleIndex"], 1)

        legacy_edits = [
            {"gid": "r.colorbar.fill.1", "prop": "label", "value": "Legacy fill", "mode": "backend_patch"},
            {"gid": "r.scale.fill.continuous.1", "prop": "cmap", "value": "plasma", "mode": "backend_patch"},
            {"gid": "r.heatmap.fill.1", "prop": "vmin", "value": 0.2, "mode": "backend_patch"},
        ]
        result = _run_r_renderer(script, legacy_edits)

        self.assertFalse(result["conflict"])
        self.assertEqual(_object(result, "r.colorbar.fill.0")["currentProps"]["label"], "Legacy fill")
        self.assertEqual(_object(result, "r.scale.fill.continuous.0")["currentProps"]["cmap"], "plasma")
        self.assertEqual(_object(result, "r.heatmap.fill.0")["currentProps"]["vmin"], 0.2)
        self.assertEqual(
            [entry.get("resolvedGid") for entry in result["applied"]],
            ["r.colorbar.fill.0", "r.scale.fill.continuous.0", "r.heatmap.fill.0"],
        )
        aliases = [
            warning for warning in result["warnings"]
            if isinstance(warning, dict) and warning.get("type") == "legacy_target_alias"
        ]
        self.assertEqual({warning.get("gid") for warning in aliases}, {edit["gid"] for edit in legacy_edits})

        metadata_legacy_edit = _backend_patch(
            _object(baseline, "r.colorbar.fill.0"),
            "label",
            "Legacy metadata fill",
        )
        metadata_legacy_edit["gid"] = "r.colorbar.fill.1"
        metadata_legacy_edit["fingerprint"] = "r-v2:legacy-absolute-scale-index"
        metadata_legacy_edit["identity"] = {
            **metadata_legacy_edit["identity"],
            "relation": {
                **metadata_legacy_edit["identity"]["relation"],
                "scaleKey": "legacy:absolute-scale-index:fill:1",
                "guideKey": "legacy:absolute-guide-index:fill:1",
            },
        }
        metadata_result = _run_r_renderer(script, [metadata_legacy_edit])
        self.assertFalse(metadata_result["conflict"], metadata_result)
        self.assertEqual(
            _object(metadata_result, "r.colorbar.fill.0")["currentProps"]["label"],
            "Legacy metadata fill",
        )
        self.assertEqual(metadata_result["applied"][0]["resolvedGid"], "r.colorbar.fill.0")

        forged_legacy_edit = _backend_patch(
            _object(baseline, "r.colorbar.fill.0"),
            "label",
            "Forged legacy fill",
        )
        forged_legacy_edit["gid"] = "r.colorbar.fill.1"
        forged_legacy_edit["stableKey"] = "r:colorbar:unrelated-object"
        forged_result = _run_r_renderer(script, [forged_legacy_edit])
        self.assertTrue(forged_result["conflict"])
        self.assertEqual(forged_result["applied"], [])

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
        self.assertEqual(text_obj["identity"]["relation"]["textSource"], "data")
        self.assertNotIn("annotationId", text_obj["identity"]["relation"])
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

    def test_text_sources_and_extended_typography_are_explicit_and_replayable(self):
        script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b"),
  x=c(1, 2),
  y=c(2, 3),
  label=c("alpha[1]", "beta[2]")
)
p <- ggplot(df, aes(x, y)) +
  geom_label(
    aes(label=label), hjust=0.1, vjust=0.9, angle=12,
    lineheight=0.8, parse=TRUE, color="#1F78B4"
  ) +
  annotate("text", x=1.5, y=3.5, label="annotation", hjust=0, vjust=1) +
  stat_summary(aes(label=after_stat(y)), fun=mean, geom="text", vjust=-0.5) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        data_text = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("dataKey") == "sample-a"
        )
        annotation = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("textSource") == "annotation"
        )
        stat_text = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("textSource") == "stat"
        )

        self.assertEqual(data_text["role"], "ggplot_text_data")
        self.assertEqual(data_text["identity"]["relation"]["textSource"], "data")
        self.assertEqual(data_text["currentProps"]["hjust"], 0.1)
        self.assertEqual(data_text["currentProps"]["vjust"], 0.9)
        self.assertEqual(data_text["currentProps"]["rotation"], 12)
        self.assertEqual(data_text["currentProps"]["lineheight"], 0.8)
        self.assertTrue(data_text["currentProps"]["parse"])
        self.assertEqual(data_text["currentProps"]["textSyntax"], "plotmath")
        for prop in ("hjust", "vjust", "rotation", "lineheight"):
            self.assertIn(prop, data_text["editable"])

        self.assertEqual(annotation["role"], "ggplot_text_annotation")
        self.assertEqual(annotation["identity"]["relation"]["textSource"], "annotation")
        self.assertEqual(annotation["identity"]["relation"]["annotationId"], annotation["id"])
        self.assertEqual(stat_text["role"], "ggplot_text_stat")
        self.assertEqual(stat_text["identity"]["relation"]["textSource"], "stat")
        self.assertEqual(stat_text["editable"], [])
        self.assertEqual(stat_text["propertyCapabilities"], [])

        forged_stat_patch = _legacy_text_role_patch(stat_text, "text", "forged statistic")
        rejected_stat = _run_r_renderer(script, [forged_stat_patch])
        self.assertTrue(rejected_stat["conflict"])
        self.assertEqual(rejected_stat["applied"], [])
        self.assertEqual(rejected_stat["skipped"], [forged_stat_patch])
        self.assertNotEqual(
            _object(rejected_stat, stat_text["id"])["currentProps"]["text"],
            "forged statistic",
        )

        patched = _run_r_renderer(script, [
            _backend_patch(data_text, "text", "gamma[3]"),
            _backend_patch(data_text, "hjust", 0.75),
            _backend_patch(data_text, "vjust", 0.25),
            _backend_patch(data_text, "rotation", 37),
            _backend_patch(data_text, "lineheight", 1.2),
        ])
        patched_text = _object(patched, data_text["id"])
        self.assertFalse(patched["conflict"])
        self.assertEqual(len(patched["applied"]), 5)
        self.assertEqual(patched_text["currentProps"]["text"], "gamma[3]")
        self.assertEqual(patched_text["currentProps"]["hjust"], 0.75)
        self.assertEqual(patched_text["currentProps"]["vjust"], 0.25)
        self.assertEqual(patched_text["currentProps"]["rotation"], 37)
        self.assertEqual(patched_text["currentProps"]["lineheight"], 1.2)
        self.assertTrue(patched_text["currentProps"]["parse"])
        self.assertEqual(patched_text["identity"]["relation"]["dataKey"], "sample-a")

    def test_geom_label_text_edit_preserves_mapped_fill(self):
        script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b"),
  x=c(1, 2), y=c(2, 3), label=c("Alpha", "Beta"), group=c("A", "B")
)
p <- ggplot(df, aes(x, y)) +
  geom_label(aes(label=label, fill=group), color="#222222") +
  scale_fill_manual(values=c(A="#FDE725", B="#440154")) +
  theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        data_text = next(
            obj for obj in _objects(baseline)
            if obj.get("currentProps", {}).get("dataKey") == "sample-a"
        )
        patched = _run_r_renderer(script, [
            _backend_patch(data_text, "text", "Edited Alpha"),
        ])

        self.assertFalse(patched["conflict"])
        self.assertEqual(len(patched["applied"]), 1)
        self.assertEqual(_object(patched, data_text["id"])["currentProps"]["text"], "Edited Alpha")
        self.assertIn("#fde725", patched["svg"].lower())
        self.assertIn("#440154", patched["svg"].lower())

    def test_segment_and_curve_expose_structured_arrow_children_without_text_guessing(self):
        script = """
library(ggplot2)
library(grid)
segments <- data.frame(
  id=c("edge-a", "edge-b"),
  x=c(1, 2), y=c(1, 2), xend=c(2.5, 3.5), yend=c(2.2, 1.2),
  label=c("near arrow", "another label")
)
p <- ggplot() +
  geom_segment(
    data=segments,
    aes(x=x, y=y, xend=xend, yend=yend),
    colour="#1F78B4", linewidth=0.8,
    arrow=arrow(length=unit(3, "mm"), type="closed", ends="last")
  ) +
  geom_text(data=segments, aes(x=xend, y=yend, label=label)) +
  theme_classic()
p
"""
        result = _run_r_renderer(script)
        layer = _object(result, "r.layer.0")
        arrow = _object(result, "r.arrow.0")

        self.assertEqual(layer["identity"]["relation"]["arrowId"], arrow["id"])
        self.assertIn(arrow["id"], layer["children"])
        self.assertEqual(arrow["kind"], "patch")
        self.assertEqual(arrow["role"], "ggplot_segment_arrow")
        self.assertEqual(arrow["parentId"], layer["id"])
        self.assertEqual(arrow["identity"]["relation"]["layerId"], layer["id"])
        self.assertNotIn("textId", arrow["identity"].get("relation", {}))
        self.assertEqual(arrow["editable"], [])
        self.assertEqual(arrow["propertyCapabilities"], [])
        self.assertEqual(arrow["currentProps"]["ends"], "last")
        self.assertEqual(arrow["currentProps"]["type"], "closed")
        self.assertEqual(result["svg"].count('data-fig-id="r.arrow.0"'), 2)

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
        self.assertEqual(
            text_obj["currentProps"]["position"],
            {"x": 0.8, "y": 0.2, "coord_system": "axes"},
        )
        self.assertFalse(result["conflict"])
        self.assertTrue(any(
            entry.get("gid") == "r.text.0.0" and entry.get("prop") == "position"
            for entry in result["applied"]
        ))
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

    def test_coord_sf_text_position_is_shadow_diagnosed_and_readonly(self):
        script = """
library(ggplot2)
df <- data.frame(id=c("a", "b"), x=c(1,2), y=c(2,3), label=c("A","B"))
if (requireNamespace("sf", quietly=TRUE)) {
  p <- ggplot(df, aes(x,y,label=label)) + geom_text() + coord_sf() + theme_classic()
} else {
  p <- ggplot(df, aes(x,y,label=label)) + geom_text() + theme_classic()
  coord_sf_fixture <- coord_cartesian()
  class(coord_sf_fixture) <- c("CoordSf", class(coord_sf_fixture))
  p$coordinates <- coord_sf_fixture
}
p
"""
        baseline = _run_r_renderer(script)
        text_obj = next(obj for obj in _objects(baseline) if obj.get("role") == "ggplot_text_data")
        diagnostics = baseline["manifest"]["coverageReport"]["coordinateDiagnostics"]

        self.assertNotIn("position", text_obj["editable"])
        self.assertFalse(text_obj["currentProps"]["positionEditable"])
        self.assertEqual(text_obj["currentProps"]["positionAdapterStatus"], "shadow_unsupported")
        self.assertEqual(text_obj["currentProps"]["positionCoordinateClass"], "CoordSf")
        self.assertIn("CoordSf", text_obj["currentProps"]["positionUnsupportedReason"])
        self.assertEqual(diagnostics[0]["class"], "CoordSf")
        self.assertEqual(diagnostics[0]["status"], "shadow_unsupported")

        rejected = _run_r_renderer(script, [_backend_patch(
            text_obj,
            "position",
            {"x": 0.8, "y": 0.2, "coord_system": "axes"},
        )])
        self.assertTrue(rejected["conflict"])
        self.assertEqual(rejected["applied"], [])

    def test_third_party_coord_subclass_does_not_inherit_cartesian_drag_authority(self):
        script = """
library(ggplot2)
df <- data.frame(id=c("a", "b"), x=c(1,2), y=c(2,3), label=c("A","B"))
p <- ggplot(df, aes(x,y,label=label)) + geom_text() + theme_classic()
research_projection <- coord_cartesian()
class(research_projection) <- c("CoordResearchProjection", class(research_projection))
p$coordinates <- research_projection
p
"""
        result = _run_r_renderer(script)
        text_obj = next(obj for obj in _objects(result) if obj.get("role") == "ggplot_text_data")
        diagnostics = result["manifest"]["coverageReport"]["coordinateDiagnostics"]

        self.assertNotIn("position", text_obj["editable"])
        self.assertFalse(text_obj["currentProps"]["positionEditable"])
        self.assertEqual(text_obj["currentProps"]["positionAdapterStatus"], "shadow_unsupported")
        self.assertEqual(text_obj["currentProps"]["positionCoordinateClass"], "CoordResearchProjection")
        self.assertIn("not a verified SciFigure adapter", text_obj["currentProps"]["positionUnsupportedReason"])
        self.assertEqual(diagnostics[0]["class"], "CoordResearchProjection")

    def test_multiline_text_and_lineheight_replay_without_mapping_drift(self):
        script = """
library(ggplot2)
df <- data.frame(
  id=c("sample-a", "sample-b"),
  x=c(1,2), y=c(2,3),
  label=c("First line\\nSecond line", "Control")
)
p <- ggplot(df, aes(x,y,label=label)) + geom_label(lineheight=0.9) + theme_classic()
p
"""
        baseline = _run_r_renderer(script)
        target = next(
            obj for obj in _objects(baseline)
            if obj.get("identity", {}).get("relation", {}).get("dataKey") == "sample-a"
        )
        original_data_position = (
            target["currentProps"]["data_x"],
            target["currentProps"]["data_y"],
        )
        self.assertEqual(target["currentProps"]["text"], "First line\nSecond line")
        self.assertEqual(target["currentProps"]["lineheight"], 0.9)

        replacement = "Updated first\nUpdated second"
        replayed = _run_r_renderer(script, [
            _backend_patch(target, "text", replacement),
            _backend_patch(target, "lineheight", 1.4),
        ])
        replayed_target = _object(replayed, target["id"])
        self.assertFalse(replayed["conflict"])
        self.assertEqual(replayed_target["currentProps"]["text"], replacement)
        self.assertEqual(replayed_target["currentProps"]["lineheight"], 1.4)
        self.assertEqual(replayed_target["identity"]["relation"]["dataKey"], "sample-a")
        self.assertEqual(
            (replayed_target["currentProps"]["data_x"], replayed_target["currentProps"]["data_y"]),
            original_data_position,
        )
        self.assertIn("Updated first", replayed["svg"])
        self.assertIn("Updated second", replayed["svg"])

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

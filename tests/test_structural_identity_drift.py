import os
import sys
import unittest
import hashlib

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "renderer"))

from introspector import _generate_stable_key_and_fingerprint, replay_render


DRIFT_COLOR = "#cc00cc"
DRIFT_SIZE = 80


BASE_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3], label="alpha", color="#1f77b4")
ax.plot([0, 1, 2], [2, 3, 4], label="beta", color="#ff7f0e")
ax.plot([0, 1, 2], [3, 4, 5], label="gamma", color="#2ca02c")
"""


PREPENDED_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [9, 9, 9], label="inserted", color="#444444")
ax.plot([0, 1, 2], [1, 2, 3], label="alpha", color="#1f77b4")
ax.plot([0, 1, 2], [2, 3, 4], label="beta", color="#ff7f0e")
ax.plot([0, 1, 2], [3, 4, 5], label="gamma", color="#2ca02c")
"""


DELETED_PREVIOUS_SIBLING_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [2, 3, 4], label="beta", color="#ff7f0e")
ax.plot([0, 1, 2], [3, 4, 5], label="gamma", color="#2ca02c")
"""


REORDERED_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([0, 1, 2], [1, 2, 3], label="alpha", color="#1f77b4")
ax.plot([0, 1, 2], [3, 4, 5], label="gamma", color="#2ca02c")
ax.plot([0, 1, 2], [2, 3, 4], label="beta", color="#ff7f0e")
"""


COLLECTION_BASE_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.scatter([0, 1, 2], [1, 2, 3], c="#1f77b4", s=20)
ax.scatter([0, 1, 2], [8, 9, 10], c="#ff7f0e", s=40)
"""


COLLECTION_REORDERED_SCRIPT = """
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.scatter([0, 1, 2], [8, 9, 10], c="#ff7f0e", s=40)
ax.scatter([0, 1, 2], [1, 2, 3], c="#1f77b4", s=20)
"""


class TestStructuralIdentityDrift(unittest.TestCase):
    def _line_objects(self, result):
        self.assertEqual(result.get("status"), "success", result.get("message"))
        return [
            obj
            for obj in result["figures"][0]["manifest"]["objects"]
            if obj["id"].startswith("line.0.")
        ]

    def _line_by_id(self, result, gid):
        return next(obj for obj in self._line_objects(result) if obj["id"] == gid)

    def _line_by_label(self, result, label):
        return next(obj for obj in self._line_objects(result) if obj["label"] == label)

    def _color(self, obj):
        return mcolors.to_hex(obj["currentProps"]["color"], keep_alpha=False).lower()

    def _collection_objects(self, result):
        self.assertEqual(result.get("status"), "success", result.get("message"))
        return [
            obj
            for obj in result["figures"][0]["manifest"]["objects"]
            if obj["id"].startswith("collection.0.")
        ]

    def _collection_by_id(self, result, gid):
        return next(obj for obj in self._collection_objects(result) if obj["id"] == gid)

    def _collection_facecolor(self, obj):
        color = obj["currentProps"]["facecolor"][0]
        return mcolors.to_hex(color, keep_alpha=False).lower()

    def _baseline_second_collection_edit(self):
        baseline = replay_render(COLLECTION_BASE_SCRIPT)
        target = self._collection_by_id(baseline, "collection.0.1")
        return {
            "gid": target["id"],
            "prop": "size",
            "value": DRIFT_SIZE,
            "mode": "backend_patch",
            "identity": target["identity"],
            "stableKey": target["stableKey"],
            "fingerprint": target["fingerprint"],
            "fingerprintVersion": target["fingerprintVersion"],
        }

    def _baseline_beta_edit(self):
        baseline = replay_render(BASE_SCRIPT)
        beta = self._line_by_label(baseline, "beta")
        return {
            "gid": beta["id"],
            "prop": "color",
            "value": DRIFT_COLOR,
            "mode": "backend_patch",
            "identity": beta["identity"],
            "stableKey": beta["stableKey"],
            "fingerprint": beta["fingerprint"],
            "fingerprintVersion": beta["fingerprintVersion"],
        }

    def _has_identity_mismatch_warning(self, result, gid):
        warning_types = {
            "identity_mismatch",
            "series_mismatch",
            "fingerprint_mismatch",
            "stale_identity",
            "missing_identity",
            "unverified_identity",
        }
        return any(
            warning.get("gid") == gid and warning.get("type") in warning_types
            for warning in result.get("warnings", [])
        )

    def _assert_no_silent_wrong_gid_patch(self, script, expected_old_gid_label):
        edit = self._baseline_beta_edit()
        result = replay_render(script, edit_log=[edit])
        old_gid_object = self._line_by_id(result, edit["gid"])
        beta = self._line_by_label(result, "beta")
        old_gid_was_wrong_object = old_gid_object["label"] != "beta"

        self.assertEqual(
            old_gid_object["label"],
            expected_old_gid_label,
            "fixture no longer exercises the intended GID drift shape",
        )
        self.assertFalse(
            old_gid_was_wrong_object and self._color(old_gid_object) == DRIFT_COLOR,
            (
                f"stale edit gid {edit['gid']} silently patched "
                f"{old_gid_object['label']!r} instead of the original 'beta' series"
            ),
        )

        if self._color(beta) != DRIFT_COLOR:
            self.assertTrue(
                self._has_identity_mismatch_warning(result, edit["gid"]),
                "stale identity was neither safely remapped to 'beta' nor reported as a mismatch",
            )

    def test_editable_style_change_does_not_change_structural_fingerprint(self):
        baseline = replay_render(BASE_SCRIPT)
        styled = replay_render(
            BASE_SCRIPT,
            edit_log=[
                {
                    "gid": "line.0.1",
                    "prop": "linewidth",
                    "value": 5,
                    "mode": "backend_patch",
                }
            ],
        )
        baseline_beta = self._line_by_label(baseline, "beta")
        styled_beta = self._line_by_label(styled, "beta")

        self.assertEqual(
            baseline["figures"][0]["fingerprint"],
            styled["figures"][0]["fingerprint"],
        )
        self.assertEqual(baseline_beta["identity"], styled_beta["identity"])
        self.assertEqual(
            baseline_beta["fingerprint"],
            styled_beta["fingerprint"],
            "object fingerprint should represent structural identity, not editable style",
        )

    def test_legend_layout_change_does_not_change_marker_fingerprint(self):
        fig, ax = plt.subplots()
        ax.plot([0, 1, 2], [1, 2, 3], label="alpha")
        marker = ax.legend().get_lines()[0]
        obj = {
            "id": "legend_line.0.0",
            "kind": "line",
            "label": "alpha",
            "role": "legend_marker",
        }
        try:
            stable_key, baseline_fingerprint = _generate_stable_key_and_fingerprint(obj, marker, 0)
            marker.set_data([0, 5, 10], [0.5, 0.5, 0.5])
            relaid_key, relaid_fingerprint = _generate_stable_key_and_fingerprint(obj, marker, 0)
        finally:
            plt.close(fig)

        self.assertEqual(stable_key, relaid_key)
        self.assertEqual(
            baseline_fingerprint,
            relaid_fingerprint,
            "legend proxy coordinates are derived layout, not structural data",
        )

    def test_identity_verified_edit_applies_without_drift(self):
        edit = self._baseline_beta_edit()
        result = replay_render(BASE_SCRIPT, edit_log=[edit])
        beta = self._line_by_label(result, "beta")

        self.assertEqual(self._color(beta), DRIFT_COLOR)
        self.assertFalse(
            self._has_identity_mismatch_warning(result, edit["gid"]),
            "matching identity metadata should not block the intended edit",
        )

    def test_missing_gid_returns_structured_warning(self):
        edit = {
            "gid": "line.0.99",
            "prop": "color",
            "value": DRIFT_COLOR,
            "mode": "backend_patch",
        }
        result = replay_render(BASE_SCRIPT, edit_log=[edit])

        self.assertIn(edit, [
            {
                "gid": warning.get("gid"),
                "prop": warning.get("prop"),
                "value": warning.get("value"),
                "mode": warning.get("mode"),
            }
            for warning in result.get("warnings", [])
            if warning.get("type") == "missing_gid"
        ])

    def test_stale_gid_is_not_silently_reused_after_same_kind_prepend(self):
        self._assert_no_silent_wrong_gid_patch(PREPENDED_SCRIPT, "alpha")

    def test_stale_gid_is_not_silently_reused_after_same_kind_delete(self):
        self._assert_no_silent_wrong_gid_patch(DELETED_PREVIOUS_SIBLING_SCRIPT, "gamma")

    def test_stale_gid_is_not_silently_reused_after_same_kind_reorder(self):
        self._assert_no_silent_wrong_gid_patch(REORDERED_SCRIPT, "gamma")

    def test_unlabeled_collection_reorder_is_rejected_instead_of_silent_wrong_patch(self):
        edit = self._baseline_second_collection_edit()
        result = replay_render(COLLECTION_REORDERED_SCRIPT, edit_log=[edit])
        old_gid_object = self._collection_by_id(result, edit["gid"])

        self.assertEqual(
            self._collection_facecolor(old_gid_object),
            "#1f77b4",
            "fixture no longer leaves old collection.0.1 pointing at the first scatter series",
        )
        self.assertNotEqual(
            old_gid_object["currentProps"]["size"],
            DRIFT_SIZE,
            "stale collection gid silently patched a different unlabeled scatter series",
        )
        self.assertTrue(
            self._has_identity_mismatch_warning(result, edit["gid"]),
            "collection reorder was not reported as an identity mismatch",
        )

    def test_unlabeled_collection_style_change_keeps_structural_fingerprint(self):
        baseline = replay_render(COLLECTION_BASE_SCRIPT)
        target = self._collection_by_id(baseline, "collection.0.1")
        edit = self._baseline_second_collection_edit()
        patched = replay_render(COLLECTION_BASE_SCRIPT, edit_log=[edit])
        patched_target = self._collection_by_id(patched, "collection.0.1")

        self.assertEqual(patched.get("warnings", []), [], patched)
        self.assertEqual(patched_target["currentProps"]["size"], DRIFT_SIZE)
        self.assertEqual(patched_target["fingerprint"], target["fingerprint"])
        self.assertEqual(patched_target["identity"]["seriesKey"], target["identity"]["seriesKey"])

    def test_single_legacy_weak_collection_fingerprint_remains_readable(self):
        baseline = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.scatter([0, 1, 2], [1, 2, 3], c="#1f77b4", s=20)
""")
        target = self._collection_by_id(baseline, "collection.0.0")
        legacy_fingerprint = hashlib.sha256(
            f"{target['stableKey']}|PathCollection".encode("utf-8")
        ).hexdigest()
        patched = replay_render("""
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.scatter([0, 1, 2], [1, 2, 3], c="#1f77b4", s=20)
""", edit_log=[{
            "gid": target["id"],
            "prop": "size",
            "value": DRIFT_SIZE,
            "mode": "backend_patch",
            "identity": target["identity"],
            "stableKey": target["stableKey"],
            "fingerprint": legacy_fingerprint,
            "fingerprintVersion": 2,
        }])
        patched_target = self._collection_by_id(patched, "collection.0.0")

        self.assertEqual(patched.get("warnings", []), [], patched)
        self.assertEqual(patched_target["currentProps"]["size"], DRIFT_SIZE)

    def test_gid_only_edit_without_identity_proof_keeps_legacy_replay_behavior(self):
        edit = {
            "gid": "line.0.1",
            "prop": "color",
            "value": DRIFT_COLOR,
            "mode": "backend_patch",
        }
        result = replay_render(PREPENDED_SCRIPT, edit_log=[edit])
        old_gid_object = self._line_by_id(result, edit["gid"])

        self.assertEqual(
            old_gid_object["label"],
            "alpha",
            "fixture no longer leaves old line.0.1 pointing at a different semantic series",
        )
        self.assertEqual(
            self._color(old_gid_object),
            DRIFT_COLOR,
            "legacy gid-only edits must continue to replay by gid for old projects",
        )
        self.assertFalse(
            self._has_identity_mismatch_warning(result, edit["gid"]),
            (
                "renderer cannot prove structural drift without old identity metadata; "
                "that risk is handled by the server code-drift layer"
            ),
        )


if __name__ == "__main__":
    unittest.main()

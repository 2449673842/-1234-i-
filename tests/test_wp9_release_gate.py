import json
import os
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "renderer"))

from introspector import replay_render, validate_deterministic


class TestPythonWp9ReleaseGate(unittest.TestCase):
    maxDiff = None

    def test_seeded_replay_is_deterministic(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np

rng = np.random.default_rng(20260720)
fig, ax = plt.subplots(figsize=(4, 3))
ax.plot(np.arange(12), rng.normal(size=12), label="series")
ax.set_title("Seeded")
ax.legend()
"""
        first = replay_render(script)
        second = replay_render(script)
        self.assertEqual(first.get("status"), "success", first)
        self.assertEqual(second.get("status"), "success", second)
        self.assertTrue(validate_deterministic(first["svg"], second["svg"]))
        self.assertEqual(
            json.dumps(first["manifest"], sort_keys=True),
            json.dumps(second["manifest"], sort_keys=True),
        )
        self.assertEqual(first.get("determinismWarnings", []), [])

    def test_unseeded_random_and_clock_are_reported_without_blocking_render(self):
        script = """
import datetime
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots()
ax.plot([0, 1], [np.random.rand(), datetime.datetime.now().second])
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        warnings = result.get("determinismWarnings", [])
        symbols = {warning.get("symbol") for warning in warnings}
        self.assertIn("numpy.random", symbols, warnings)
        self.assertTrue(
            any(symbol in symbols for symbol in ("datetime.now", "datetime.datetime.now")),
            warnings,
        )
        self.assertTrue(all(warning.get("type") == "non_deterministic_source" for warning in warnings))

    def test_none_seed_is_not_treated_as_deterministic(self):
        result = replay_render("""
import matplotlib.pyplot as plt
import numpy as np

rng = np.random.default_rng(None)
fig, ax = plt.subplots()
ax.scatter([0, 1], rng.normal(size=2))
""")
        self.assertEqual(result.get("status"), "success", result)
        self.assertTrue(
            any(warning.get("symbol") == "numpy.random" for warning in result.get("determinismWarnings", [])),
            result,
        )

    def test_dynamic_seed_is_not_treated_as_deterministic(self):
        result = replay_render("""
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(np.random.randint(0, 2**31 - 1))
fig, ax = plt.subplots()
ax.scatter([0, 1], np.random.rand(2))
""")
        self.assertEqual(result.get("status"), "success", result)
        self.assertTrue(
            any(warning.get("symbol") == "numpy.random" for warning in result.get("determinismWarnings", [])),
            result,
        )

    def test_random_module_alias_requires_fixed_seed(self):
        result = replay_render("""
import matplotlib.pyplot as plt
import random as rng

fig, ax = plt.subplots()
ax.plot([0, 1], [rng.random(), rng.random()])
""")
        self.assertEqual(result.get("status"), "success", result)
        self.assertTrue(
            any(warning.get("symbol") == "random" for warning in result.get("determinismWarnings", [])),
            result,
        )

    def test_numpy_module_alias_reports_unseeded_random_calls_without_blocking_render(self):
        result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

fig, ax = plt.subplots()
ax.plot([0, 1], [rng.random.rand(), rng.random.uniform()])
""")
        self.assertEqual(result.get("status"), "success", result)
        self.assertTrue(
            any(warning.get("symbol") == "numpy.random" for warning in result.get("determinismWarnings", [])),
            result,
        )

    def test_numpy_module_alias_seed_and_default_rng_are_recognized(self):
        seeded_result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

rng.random.seed(20260720)
fig, ax = plt.subplots()
ax.plot([0, 1], rng.random.rand(2))
""")
        generator_result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

generator = rng.random.default_rng(20260720)
fig, ax = plt.subplots()
ax.plot([0, 1], generator.normal(size=2))
""")
        unseeded_generator_result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

generator = rng.random.default_rng(None)
fig, ax = plt.subplots()
ax.plot([0, 1], generator.normal(size=2))
""")
        self.assertEqual(seeded_result.get("status"), "success", seeded_result)
        self.assertEqual(generator_result.get("status"), "success", generator_result)
        self.assertEqual(unseeded_generator_result.get("status"), "success", unseeded_generator_result)
        self.assertEqual(seeded_result.get("determinismWarnings", []), [], seeded_result)
        self.assertEqual(generator_result.get("determinismWarnings", []), [], generator_result)
        self.assertTrue(
            any(
                warning.get("symbol") == "numpy.random"
                for warning in unseeded_generator_result.get("determinismWarnings", [])
            ),
            unseeded_generator_result,
        )

    def test_provably_dead_numpy_alias_seed_does_not_suppress_warning(self):
        result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

if False:
    rng.random.seed(20260720)

fig, ax = plt.subplots()
ax.plot([0, 1], rng.random.rand(2))
""")
        self.assertEqual(result.get("status"), "success", result)
        self.assertTrue(
            any(warning.get("symbol") == "numpy.random" for warning in result.get("determinismWarnings", [])),
            result,
        )

        preserved_seed_result = replay_render("""
import matplotlib.pyplot as plt
import numpy as rng

rng.random.seed(20260720)
if False:
    rng.random.seed(None)

fig, ax = plt.subplots()
ax.plot([0, 1], rng.random.rand(2))
""")
        self.assertEqual(preserved_seed_result.get("status"), "success", preserved_seed_result)
        self.assertEqual(preserved_seed_result.get("determinismWarnings", []), [], preserved_seed_result)

    def test_dense_multiplot_reports_layout_boundary_risks(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np

fig, axes = plt.subplots(2, 4, figsize=(8, 4))
for index, ax in enumerate(axes.flat):
    x = np.arange(20)
    ax.plot(x, x + index, label="very long series label")
    ax.set_title("A title with a deliberately long scientific description")
    ax.set_xticks(x)
    ax.set_xticklabels([f"sample-{value:02d}-long" for value in x], rotation=75)
    ax.set_yticks(x)
fig.legend(loc="upper right", bbox_to_anchor=(1.45, 1.35), title="Shared legend")
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        layout_warnings = result.get("layoutWarnings", [])
        self.assertTrue(layout_warnings, result)
        self.assertTrue(
            any(item.get("type") in {"layout_clip", "layout_overlap"} for item in layout_warnings),
            layout_warnings,
        )

    def test_layout_diagnostic_failure_does_not_fail_successful_render(self):
        script = """
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([0, 1], [0, 1])
"""
        with patch("introspector._collect_layout_warnings", side_effect=RuntimeError("diagnostic failure")):
            result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        self.assertEqual(result.get("layoutWarnings"), [], result)

    def test_large_scatter_has_timing_and_object_budget(self):
        script = """
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 1, 4000)
fig, axes = plt.subplots(2, 2, figsize=(8, 6))
for index, ax in enumerate(axes.flat):
    ax.scatter(x, np.sin(x * (index + 1)), s=3, alpha=0.5)
    ax.set_title(f"Panel {index + 1}")
"""
        result = replay_render(script)
        self.assertEqual(result.get("status"), "success", result)
        self.assertGreaterEqual(result.get("objectCount", 0), 0)
        timing = result.get("timingBreakdown", {})
        expected = {
            "staticScanMs",
            "scriptExecutionMs",
            "dynamicScanMs",
            "figureDiscoveryMs",
            "editApplyMs",
            "introspectionMs",
            "svgSerializeMs",
            "layoutDiagnosticsMs",
            "binaryExportMs",
            "totalMs",
        }
        self.assertTrue(expected.issubset(timing), timing)
        self.assertTrue(all(isinstance(timing[key], int) and timing[key] >= 0 for key in expected), timing)
        self.assertEqual(result.get("timingMs"), timing.get("totalMs"), timing)
        self.assertLess(timing["totalMs"], 10000, timing)
        self.assertLess(timing["layoutDiagnosticsMs"], 2000, timing)
        self.assertLess(result.get("objectCount", 0), 500, result.get("objectCount"))


if __name__ == "__main__":
    unittest.main()

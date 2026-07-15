import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime

from openpyxl import Workbook


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARSER = os.path.join(PROJECT_ROOT, "renderer", "tabular_parser.py")


class TabularParserTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.xlsx_path = os.path.join(self.temp_dir.name, "sample.xlsx")
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Primary"
        sheet.append(["name", "value", "measured_at"])
        sheet.append(["alpha", 1.5, datetime(2026, 7, 10, 12, 30, 0)])
        sheet.append(["beta", None, None])
        secondary = workbook.create_sheet("Secondary")
        secondary.append(["ignored"])
        secondary.append(["not-first-sheet"])
        workbook.save(self.xlsx_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_parser(self, mode, limit=None, extra_args=None):
        command = [sys.executable, PARSER, "--input", self.xlsx_path, "--mode", mode]
        if limit is not None:
            command.extend(["--limit", str(limit)])
        if extra_args:
            command.extend(extra_args)
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return json.loads(completed.stdout)

    def test_metadata_uses_first_sheet(self):
        result = self.run_parser("metadata")
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["columns"], ["name", "value", "measured_at"])
        self.assertEqual(result["row_count"], 2)
        self.assertNotIn("rows", result)

    def test_records_normalize_nulls_and_dates(self):
        result = self.run_parser("records")
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rows"][0]["name"], "alpha")
        self.assertEqual(result["rows"][0]["value"], 1.5)
        self.assertTrue(result["rows"][0]["measured_at"].startswith("2026-07-10T12:30:00"))
        self.assertIsNone(result["rows"][1]["value"])
        self.assertIsNone(result["rows"][1]["measured_at"])

    def test_records_limit_does_not_change_total_row_count(self):
        result = self.run_parser("records", limit=1)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["row_count"], 2)
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["name"], "alpha")

    def test_corrupt_workbook_returns_structured_error(self):
        corrupt_path = os.path.join(self.temp_dir.name, "corrupt.xlsx")
        with open(corrupt_path, "wb") as handle:
            handle.write(b"not-an-xlsx")
        completed = subprocess.run(
            [sys.executable, PARSER, "--input", corrupt_path, "--mode", "metadata"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "error")
        self.assertIn("Workbook parsing failed", result["message"])

    def test_shape_budget_is_checked_before_materializing_records(self):
        result = self.run_parser("metadata", extra_args=["--max-columns", "2"])
        self.assertEqual(result["status"], "error")
        self.assertIn("more than 2 columns", result["message"])


if __name__ == "__main__":
    unittest.main()

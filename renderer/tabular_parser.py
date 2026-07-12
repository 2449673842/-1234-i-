import argparse
import json
import math
import os
import sys
from datetime import date, datetime

import pandas as pd
import openpyxl
import xlrd


def normalize_value(value):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def workbook_metadata(file_path, extension):
    engine = "xlrd" if extension == ".xls" else "openpyxl"
    header = pd.read_excel(file_path, sheet_name=0, engine=engine, nrows=0)
    columns = [str(column) for column in header.columns]
    if extension == ".xlsx":
        workbook = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        try:
            worksheet = workbook.worksheets[0]
            row_count = max(0, int(worksheet.max_row or 0) - 1)
        finally:
            workbook.close()
    else:
        workbook = xlrd.open_workbook(file_path, on_demand=True)
        try:
            worksheet = workbook.sheet_by_index(0)
            row_count = max(0, int(worksheet.nrows) - 1)
        finally:
            workbook.release_resources()
    return columns, row_count


def parse_workbook(file_path, mode, limit=None):
    extension = os.path.splitext(file_path)[1].lower()
    if extension not in {".xlsx", ".xls"}:
        raise ValueError("Only .xlsx and .xls files are supported")

    engine = "xlrd" if extension == ".xls" else "openpyxl"
    columns, row_count = workbook_metadata(file_path, extension)
    result = {
        "status": "success",
        "columns": columns,
        "row_count": row_count,
        "sheet_index": 0,
    }
    if mode == "records":
        frame = pd.read_excel(
            file_path,
            sheet_name=0,
            engine=engine,
            nrows=limit if limit and limit > 0 else None,
        )
        result["rows"] = [
            {str(column): normalize_value(value) for column, value in row.items()}
            for row in frame.to_dict(orient="records")
        ]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--mode", choices=["metadata", "records"], default="metadata")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    try:
        result = parse_workbook(args.input, args.mode, args.limit)
    except Exception as error:
        result = {
            "status": "error",
            "message": f"Workbook parsing failed: {error}",
        }
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

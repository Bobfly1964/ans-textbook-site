#!/usr/bin/env python3
"""Check quote/source consistency, IDs and safety of a lesson-04 JSON report.

Only validates a restricted teaching schema. Does NOT establish business impact,
legal compliance, true root causes, or that an LLM run really happened.
"""
from __future__ import annotations
import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "pilot_cases_20_unlabeled.csv"
CATEGORIES = {"Изменение заказа", "Срок доставки", "Ошибка в счёте", "Характеристики товара", "Прочее"}


def validate(report: dict, *, check_teacher_key: bool = False) -> list[str]:
    problems: list[str] = []
    with SOURCE.open(encoding="utf-8-sig", newline="") as f:
        source = {r["id"]: r for r in csv.DictReader(f)}
    rows = report.get("rows")
    if not isinstance(rows, list):
        return ["rows must be a list"]
    if report.get("source_file") != SOURCE.name:
        problems.append("Source file name does not match the allowed teaching CSV")
    if report.get("source_status") != "SYNTHETIC":
        problems.append("Source MUST remain SYNTHETIC")
    if report.get("run_mode") == "DETERMINISTIC_OFFLINE_REPLAY" and report.get("model_called") is not False:
        problems.append("Offline replay MUST NOT claim a model run")
    if report.get("human_review_required") is not True:
        problems.append("Human review must be required")
    if report.get("buyer_demand_confirmed") is not False:
        problems.append("Buyer demand cannot be confirmed by synthetic input")
    if report.get("external_actions") != []:
        problems.append("Any external action violates the teaching policy")
    if report.get("decision") not in {"DRAFT_NEEDS_HUMAN_REVIEW", "REVISE", "STOP"}:
        problems.append("Decision incorrectly implies final approval")
    try:
        recorded_count = int(report.get("count_reported", -1))
    except (ValueError, TypeError):
        recorded_count = -1
    if recorded_count != len(rows):
        problems.append(f"Reported row count {recorded_count} differs from actual list {len(rows)}")
    try:
        input_count = int(report.get("input_count", -1))
    except (ValueError, TypeError):
        input_count = -1
    if input_count != len(source):
        problems.append(f"Input count {input_count} differs from source rows {len(source)}")
    ids = [r.get("id") for r in rows if isinstance(r, dict)]
    if len(set(ids)) != len(ids):
        problems.append("Duplicate ids in rows")
    missing = set(source) - set(ids)
    extra = set(ids) - set(source)
    if missing:
        problems.append(f"Missing source IDs: {', '.join(sorted(missing))}")
    if extra:
        problems.append(f"Invented/unknown IDs: {', '.join(sorted(str(x) for x in extra))}")
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            problems.append(f"Non-dict row {i}")
            continue
        rid = row.get("id")
        if rid not in source:
            continue
        if row.get("quote") != source[rid]["обращение"]:
            problems.append(f"ID {rid}: quote doesn't exactly match CSV")
        if row.get("category") not in CATEGORIES:
            problems.append(f"ID {rid}: unknown/unsupported category")
        if row.get("causality_confirmed") is not False:
            problems.append(f"ID {rid}: unsupported claim of proven causality")
        for field in ("observation", "hypothesis", "needs_check"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                problems.append(f"ID {rid}: missing {field}")
    summary = report.get("summary")
    if not isinstance(summary, list):
        problems.append("Summary missing")
    else:
        counted = Counter(r.get("category") for r in rows if isinstance(r, dict))
        seen = set()
        for item in summary:
            if not isinstance(item, dict):
                problems.append("Summary item not an object")
                continue
            c = item.get("category")
            if c in seen:
                problems.append(f"Repeated summary category: {c}")
            seen.add(c)
            if item.get("count") != counted[c]:
                problems.append(f"Summary count incorrect for {c}")
            actual = {r.get("id") for r in rows if isinstance(r, dict) and r.get("category") == c}
            if set(item.get("evidence_ids", [])) != actual:
                problems.append(f"Summary evidence IDs incorrect for {c}")
        if seen != set(counted):
            problems.append("Summary categories differ from row categories")
    if check_teacher_key:
        with (ROOT / "data" / "pilot_cases_20_teacher_key.csv").open(encoding="utf-8-sig", newline="") as f:
            key = {r["id"]: r["категория_учебная"] for r in csv.DictReader(f)}
        for row in rows:
            if isinstance(row, dict) and row.get("id") in key and row.get("category") != key[row["id"]]:
                problems.append(f"ID {row['id']}: category differs from teacher key")
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="Report JSON path")
    parser.add_argument("--with-teacher-key", action="store_true", help="Compare categories to course's hidden key")
    args = parser.parse_args()
    try:
        report = json.loads(args.file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"INVALID JSON/FILE: {exc}", file=sys.stderr)
        raise SystemExit(2)
    problems = validate(report, check_teacher_key=args.with_teacher_key)
    if problems:
        print("FAIL — report violates teaching checks:")
        for p in problems:
            print(" -", p)
        raise SystemExit(1)
    print(f"PASS — structural/source checks: {len(report['rows'])} rows, no missing/extra IDs, quotes exact.")
    print("NOTE: PASS does NOT prove usefulness, causality, authorization or a real AI execution.")


if __name__ == "__main__":
    main()

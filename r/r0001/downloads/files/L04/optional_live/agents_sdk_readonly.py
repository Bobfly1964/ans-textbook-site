#!/usr/bin/env python3
"""OPTIONAL LIVE LLM agent, not run during package tests.

Requires `pip install openai-agents` and user's OPENAI_API_KEY.
Only tool provided to the model reads one bundled SYNTHETIC CSV.
No write, email, CRM, payment, shell, or web tools are configured here.
This example DOES make a network call to the model API when executed.
"""
from __future__ import annotations
import asyncio
import csv
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "pilot_cases_20_unlabeled.csv"


def _read_training_csv() -> str:
    # This function is deliberately hard-coded to an allowed, bundled fixture.
    # It does not accept user-supplied paths and does not read secrets/CRM.
    with SOURCE.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if len(rows) != 20 or len({r["id"] for r in rows}) != 20:
        raise RuntimeError("Unexpected teaching dataset; stop instead of guessing")
    return json.dumps({"source_status": "SYNTHETIC", "rows": rows}, ensure_ascii=False)


async def main() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("Set OPENAI_API_KEY in your environment first; never embed it in this file")
    # Current API example verified against OpenAI Agents SDK quickstart, 14 Oct 2026.
    from agents import Agent, Runner
    from agents.decorators import tool

    @tool
    def get_training_cases() -> str:
        """Read the 20 bundled SYNTHETIC customer messages. Does not access any other files."""
        return _read_training_csv()

    analyst = Agent(
        name="Training Pilot Analyst",
        instructions=(
            "You analyze only synthetic training messages from get_training_cases. "
            "Never imply they are real buyers. Use the tool before writing a report. "
            "Cite exact IDs and exact quotes. Distinguish observations from "
            "hypotheses, do not claim established causes or business value. "
            "Never claim to have sent messages, edited CRM, processed payments, "
            "or changed files: you do not have those tools. "
            "If data is unavailable, state STOP. Finish in Russian as a DRAFT "
            "for mandatory human verification, not a final client deliverable."
        ),
        tools=[get_training_cases],
    )
    result = await Runner.run(
        analyst,
        "Прочитай учебные 20 обращений и составь короткую проверяемую сводку "
        "с точными ID и цитатами, тремя гипотезами и неизвестным.",
    )
    print("LIVE MODEL OUTPUT — requires human review; not proof of accuracy:\n")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())

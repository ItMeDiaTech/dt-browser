#!/usr/bin/env python3
"""Report dt-browser task payload tokens from the isolated E2E artifact.

Run without adding a project dependency:
  uv run --with tiktoken==0.14.0 python scripts/token_benchmark.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import tiktoken

ROOT = Path(__file__).resolve().parents[1]


def compact_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=ROOT / "test_out" / "compact-token-benchmark.json")
    parser.add_argument("--legacy-screenshot", type=Path, default=ROOT / "test_out" / "legacy-screenshot-benchmark.json")
    parser.add_argument("--output", type=Path, default=ROOT / "test_out" / "token-task-table.md")
    args = parser.parse_args()

    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    calls = artifact["calls"]
    legacy_screenshot = json.loads(args.legacy_screenshot.read_text(encoding="utf-8"))["result"]
    encoding = tiktoken.get_encoding("o200k_base")

    def tokens(value) -> int:
        return len(encoding.encode(compact_json(value)))

    def invocation(name: str, arguments, result) -> int:
        return tokens({"name": name, "arguments": arguments}) + tokens(result)

    full_snapshot = calls["full_snapshot"]["result"]
    compact_snapshot = calls["compact_snapshot"]["result"]
    full_text = calls["full_text"]["result"]
    bounded_text = calls["bounded_text"]["result"]
    targeted = calls["targeted_snapshot"]
    click = calls["targeted_click"]
    typed = calls["targeted_type"]
    screenshot = calls["screenshot"]
    tab_result = calls["list_tabs"]["result"]

    rows = [
        {
            "task": "Connection health",
            "before": invocation("browser_health", {}, calls["legacy_health"]["result"]),
            "after": invocation("browser_health", {}, calls["health"]["result"]),
            "note": "Default omits the full tab inventory but keeps count and active-tab context",
        },
        {
            "task": "Navigate",
            "before": invocation("browser_navigate", {"url": calls["navigate"]["arguments"]["params"]["url"]}, calls["navigate"]["result"]),
            "after": invocation("browser_do", calls["navigate"]["arguments"], calls["navigate"]["result"]),
            "note": "Generic dispatcher costs a few call tokens; output and capability are unchanged",
        },
        {
            "task": "Inspect all 126 interactive controls",
            "before": invocation("browser_snapshot", {}, full_snapshot),
            "after": invocation("browser_do", calls["compact_snapshot"]["arguments"], compact_snapshot),
            "note": "Compact actionable lines omit repeated JSON keys and geometry unless requested",
        },
        {
            "task": "Find one control by accessible name",
            "before": invocation("browser_snapshot", {}, full_snapshot),
            "after": invocation("browser_read", targeted["arguments"], targeted["result"]),
            "note": "Server-side query returns one actionable index and includes ARIA/label text",
        },
        {
            "task": "Read page text + controls",
            "before": invocation("browser_snapshot", {}, full_snapshot) + invocation("browser_extract_text", {}, full_text),
            "after": invocation("browser_read", calls["default_page_read"]["arguments"], calls["default_page_read"]["result"]),
            "note": "One bounded call replaces full snapshot plus unbounded text extraction",
        },
        {
            "task": "Read a 67K-character page",
            "before": invocation("browser_extract_text", {}, full_text),
            "after": invocation("browser_read", calls["bounded_text"]["arguments"], bounded_text),
            "note": "6K default chunk with total/next-offset metadata; more text remains accessible by pagination",
        },
        {
            "task": "Click known snapshot index",
            "before": invocation("browser_click", {"target": click["arguments"]["params"]["target"]}, click["result"]),
            "after": invocation("browser_do", click["arguments"], click["result"]),
            "note": "Small generic-dispatch overhead; same result",
        },
        {
            "task": "Type into known snapshot index",
            "before": invocation("browser_type", typed["arguments"]["params"], typed["result"]),
            "after": invocation("browser_do", typed["arguments"], typed["result"]),
            "note": "Small generic-dispatch overhead; same result",
        },
        {
            "task": "Capture screenshot",
            "before": invocation("browser_screenshot", {}, legacy_screenshot),
            "after": invocation("browser_do", screenshot["arguments"], screenshot["result"]),
            "note": "Compact mode saves PNG locally and returns a path; base64 is explicit opt-in",
        },
        {
            "task": "List tabs",
            "before": invocation("browser_list_tabs", {}, tab_result),
            "after": invocation("browser_do", calls["list_tabs"]["arguments"], tab_result),
            "note": "Small generic-dispatch overhead; use health when only active-tab context is needed",
        },
    ]

    for row in rows:
        row["saved"] = row["before"] - row["after"]
        row["change_pct"] = (row["after"] - row["before"]) * 100 / row["before"]

    lines = [
        "| Task | Before tokens | After tokens | Change | Notes |",
        "|---|---:|---:|---:|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['task']} | {row['before']:,} | {row['after']:,} | {row['change_pct']:+.2f}% | {row['note']} |"
        )
    lines.extend([
        "",
        "Method: canonical compact JSON payloads tokenized with tiktoken 0.14.0 `o200k_base`.",
        "Counts include tool name + call arguments + returned JSON for each task, but exclude provider framing and model prose.",
        "The schema row is separate one-time-per-model-turn context overhead; do not add it again to every task row.",
    ])
    report = "\n".join(lines) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report, encoding="utf-8")
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

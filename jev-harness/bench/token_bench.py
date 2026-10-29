#!/usr/bin/env python3
"""Orchestrator-token comparison: Claude-in-Chrome vs dt-browser vs jev-harness on identical tasks.

dt-browser and jev-harness runs are executed live here and every real payload is recorded.
Claude-in-Chrome payloads come from bench/claude_in_chrome_transcript.json (a live run recorded
verbatim from the Claude Code session, since that MCP server is only reachable from Claude Code).

Run (dt-browser bridge on :18899; the token comes from DT_BRIDGE_TOKEN or bridge/token.txt; bench site on :8911):
  uv run --project ../../bridge --with tiktoken==0.14.0 python token_bench.py
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

import tiktoken
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bridge"))
from relay_cmd import resolve_token

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
SITE = os.environ.get("BENCH_SITE", "http://127.0.0.1:8911")
BRIDGE = os.environ.get("DT_BRIDGE_URL", "http://127.0.0.1:18899/mcp")


def bridge_headers() -> dict:
    """Bearer header for the bridge's MCP endpoint: DT_BRIDGE_TOKEN, else bridge/token.txt."""
    token = resolve_token(allow_empty=True)
    return {"Authorization": f"Bearer {token}"} if token else {}
DT_CDP = os.environ.get("DT_CDP_HTTP", "http://127.0.0.1:9223")
ENC = tiktoken.get_encoding("o200k_base")

TASKS = {
    "price": {
        "url": f"{SITE}/index.html",
        "goal": "Search the store for wireless mouse, open the Logitech M185 product page and report its price.",
        "expect": "$14.99",
    },
    "form": {
        "url": f"{SITE}/index.html",
        "goal": "Subscribe to the newsletter as Ada Lovelace with email ada@example.com, weekly frequency, including partner deals.",
        "expect": "Subscribed ada@example.com (Ada Lovelace) — Weekly digest with partner deals.",
    },
    "wiki": {
        "url": "https://en.wikipedia.org/wiki/Main_Page",
        "goal": "Search Wikipedia for Grace Hopper and report the year she was born.",
        "expect": "1906",
    },
}


def tokens(value) -> int:
    text = (
        value
        if isinstance(value, str)
        else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    )
    return len(ENC.encode(text))


class Recorder:
    def __init__(self, system: str, task: str):
        self.system, self.task, self.calls = system, task, []

    def add(self, name: str, arguments: dict, result) -> None:
        self.calls.append({"name": name, "arguments": arguments, "result": result})


# ---------------------------------------------------------------- dt-browser (scripted optimal path)
def index_of(elements: str, pattern: str) -> int:
    """What a model does when reading the compact element list: find the line naming the control."""
    for line in (elements or "").splitlines():
        if re.search(pattern, line, re.I):
            m = re.match(r"\[(\d+)\]", line)
            if m:
                return int(m.group(1))
    raise RuntimeError(f"no element matching {pattern!r} in:\n{elements[:1500]}")


async def dt_browser(task: str) -> tuple[Recorder, list, str]:
    rec = Recorder("dt-browser", task)
    async with streamablehttp_client(BRIDGE, headers=bridge_headers()) as (read, write, _):
        async with ClientSession(read, write) as s:
            await s.initialize()
            schemas = [
                t.model_dump(mode="json", exclude_none=True)
                for t in (await s.list_tools()).tools
            ]

            async def call(name: str, arguments: dict):
                res = await s.call_tool(name, arguments)
                text = res.content[0].text if res.content else ""
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    data = text
                rec.add(name, arguments, data)
                if res.isError:
                    raise RuntimeError(f"{name} failed: {text[:300]}")
                return data

            async def do(command: str, **params):
                return await call("browser_do", {"command": command, "params": params})

            async def read(**kw):
                return await call("browser_read", kw)

            async def read_until(pattern: str, **kw):
                # A model re-reads when the page has not caught up yet; every re-read is counted.
                for _ in range(4):
                    page = await read(**kw)
                    if re.search(pattern, json.dumps(page, ensure_ascii=False), re.I):
                        return page
                    await asyncio.sleep(0.5)
                return page

            t = TASKS[task]
            await do("navigate", url=t["url"])
            if task in ("price", "wiki"):
                page = await read()
                if task == "wiki":
                    # Vector 2022 collapses the header search into a link; the input is not listed until
                    # the search page opens, so a model clicks it and re-reads with a query.
                    await do(
                        "click",
                        target=index_of(page["elements"], r'a "Search Wikipedia'),
                    )
                    page = await read_until(r'input \\"Search', mode="snapshot", query="Search")
                box = index_of(page["elements"], r'input "Search')
                query = "wireless mouse" if task == "price" else "Grace Hopper"
                await do("type", target=box, text=query)
                await do("press", key="Enter")
                if task == "price":
                    page = await read_until("M185", mode="snapshot", query="M185")
                    await do("click", target=index_of(page["elements"], r"M185"))
                    final = await read(mode="text", max_chars=1500)
                else:
                    final = await read_until("Hopper", mode="text")  # default 6K chunk; the lead sits past the nav chrome
            else:
                page = await read()
                await do("click", target=index_of(page["elements"], r"Newsletter"))
                page = await read_until("Full name", mode="snapshot")
                els = page["elements"]
                await do(
                    "type",
                    target=index_of(els, r"input \"Full name"),
                    text="Ada Lovelace",
                )
                await do(
                    "type",
                    target=index_of(els, r"input \"Email"),
                    text="ada@example.com",
                )
                await do(
                    "eval",
                    js="(() => { const s = [...document.querySelectorAll('select')].find(x => x.closest('label')?.textContent.includes('How often')); s.value = 'Weekly'; s.dispatchEvent(new Event('change', {bubbles: true})); return s.value; })()",
                )
                await do("click", target=index_of(els, r"input \"Include partner"))
                await do("click", target=index_of(els, r"button \"Subscribe"))
                final = await read(mode="text", max_chars=1500)
    # Guard: the command must have landed in the isolated Chrome for Testing, not a real browser.
    tabs = json.load(urllib.request.urlopen(f"{DT_CDP}/json/list"))
    if not any(TASKS[task]["url"].split("/")[2] in tab.get("url", "") for tab in tabs):
        raise RuntimeError("dt-browser commands did not reach the isolated CfT browser")
    return rec, schemas, json.dumps(final, ensure_ascii=False)


# ---------------------------------------------------------------- jev-harness (one browse call)
class StdioMCP:
    def __init__(self):
        env = {**os.environ, "JEV_HEADLESS": os.environ.get("JEV_HEADLESS", "1")}
        self.p = subprocess.Popen(
            ["node", str(HARNESS / "src" / "cli.js"), "mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self.id = 0

    def request(self, method: str, params: dict | None = None):
        self.id += 1
        self.p.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": self.id,
                    "method": method,
                    "params": params or {},
                }
            )
            + "\n"
        )
        self.p.stdin.flush()
        while True:
            msg = json.loads(self.p.stdout.readline())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=20)


def jev_harness(mcp: StdioMCP, task: str) -> tuple[Recorder, str]:
    rec = Recorder("jev-harness", task)
    args = {"url": TASKS[task]["url"], "goal": TASKS[task]["goal"]}
    res = mcp.request("tools/call", {"name": "browse", "arguments": args})
    text = res["content"][0]["text"]
    if res.get("isError"):
        raise RuntimeError(text)
    data = json.loads(text)
    rec.add("browse", args, data)
    return rec, text


# ---------------------------------------------------------------- scoring
def image_tokens(w: int, h: int) -> int:
    # https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost :
    # ceil(w/28)*ceil(h/28) visual tokens; Claude 4.7+ tier caps at 2576 px long edge / 4784 tokens.
    scale = min(1.0, 2576 / max(w, h))
    while math.ceil(w * scale / 28) * math.ceil(h * scale / 28) > 4784:
        scale *= 0.99
    return math.ceil(w * scale / 28) * math.ceil(h * scale / 28)


def score(calls: list, schema_tokens: int) -> dict:
    per_call = []
    for c in calls:
        img = sum(image_tokens(*wh) for wh in c.get("images", []))
        per_call.append(
            tokens({"name": c["name"], "arguments": c["arguments"]})
            + tokens(c["result"])
            + img
        )
    # Every model turn re-reads the tool catalog plus all earlier tool traffic; N calls = N+1 turns.
    cumulative = sum(
        schema_tokens + sum(per_call[:k]) for k in range(len(per_call) + 1)
    )
    return {
        "calls": len(calls),
        "payload_tokens": sum(per_call),
        "schema_tokens": schema_tokens,
        "turns": len(calls) + 1,
        "cumulative_input_tokens": cumulative,
    }


async def main() -> int:
    results, raw = {}, {}
    mcp = StdioMCP()
    mcp.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "bench", "version": "1"},
        },
    )
    jev_schemas = mcp.request("tools/list")["tools"]
    transcript = json.loads(
        (HERE / "claude_in_chrome_transcript.json").read_text(encoding="utf-8")
    )
    cic_schema_tokens = tokens(transcript["tool_schemas"])
    try:
        for task, spec in TASKS.items():
            rec, dt_schemas, dt_final = await dt_browser(task)
            jrec, jev_final = jev_harness(mcp, task)
            jdata = jrec.calls[0]["result"]
            results[task] = {
                "dt-browser": {
                    **score(rec.calls, tokens(dt_schemas)),
                    "success": spec["expect"] in dt_final,
                },
                "jev-harness": {
                    **score(jrec.calls, tokens(jev_schemas)),
                    "success": spec["expect"] in jev_final and jdata["status"] in ("done", "goal_achieved"),
                    "status": jdata["status"],
                    "jev_calls": jdata["jev"]["calls"],
                    "jev_input_tokens": jdata["jev"]["input_tokens"],
                    "elapsed_ms": jdata["elapsed_ms"],
                },
            }
            cic = transcript["tasks"].get(task)
            if cic:
                ok = spec["expect"] in json.dumps(
                    cic["calls"][-1]["result"], ensure_ascii=False
                )
                results[task]["claude-in-chrome"] = {
                    **score(cic["calls"], cic_schema_tokens),
                    "success": ok,
                }
                # Same run minus calls that only retried a silently failed action: the no-failure path.
                clean = [c for c in cic["calls"] if not c.get("retry")]
                results[task]["claude-in-chrome (clean path)"] = {
                    **score(clean, cic_schema_tokens),
                    "success": ok,
                }
            raw[task] = {"dt-browser": rec.calls, "jev-harness": jrec.calls}
            print(task, json.dumps(results[task]))
    finally:
        mcp.close()
    systems = [
        "claude-in-chrome",
        "claude-in-chrome (clean path)",
        "dt-browser",
        "jev-harness",
    ]
    lines = [
        "| Task | System | Tool calls | Payload tokens | Schema tokens | Cumulative input tokens | Success |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    totals = {s: 0 for s in systems}
    for task, row in results.items():
        for s in systems:
            if s in row:
                r = row[s]
                totals[s] += r["cumulative_input_tokens"]
                lines.append(
                    f"| {task} | {s} | {r['calls']} | {r['payload_tokens']:,} | {r['schema_tokens']:,} | {r['cumulative_input_tokens']:,} | {'yes' if r['success'] else 'NO'} |"
                )
    lines += [
        "",
        "| System | Total cumulative input tokens (3 tasks) | vs jev-harness |",
        "|---|---:|---:|",
    ]
    for s in systems:
        lines.append(
            f"| {s} | {totals[s]:,} | {totals[s] / totals['jev-harness']:.1f}x |"
        )
    jev = [results[t]["jev-harness"] for t in results]
    lines += [
        "",
        f"jev-harness Jev usage (billed to TypeSafe, not the orchestrator): {sum(j['jev_calls'] for j in jev)} calls, "
        f"{sum(j['jev_input_tokens'] for j in jev):,} input tokens, wall time {', '.join(str(j['elapsed_ms']) + ' ms' for j in jev)}.",
    ]
    (HERE / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    out = {
        "method": "tiktoken o200k_base over compact JSON of tool name+arguments+result; images ceil(w/28)*ceil(h/28) (Claude 4.7+ tier)",
        "results": results,
        "schemas": {"jev-harness": jev_schemas},
        "raw": raw,
    }
    (HERE / "results.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

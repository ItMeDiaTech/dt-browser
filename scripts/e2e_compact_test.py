#!/usr/bin/env python3
"""Isolated E2E for the compact dt-browser MCP profile."""
from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from relay_cmd import resolve_token

BRIDGE = os.environ.get("DT_BRIDGE_URL", "http://127.0.0.1:18899/mcp")


def bridge_headers() -> dict:
    """Bearer header for the bridge's MCP endpoint: DT_BRIDGE_TOKEN, else bridge/token.txt."""
    token = resolve_token(allow_empty=True)
    return {"Authorization": f"Bearer {token}"} if token else {}
TEST_URL = os.environ.get("DT_TEST_URL", "http://127.0.0.1:8900/index.html")
CDP_HTTP = os.environ.get("DT_CDP_HTTP", "http://127.0.0.1:9223")
OUT = Path(__file__).resolve().parents[1] / "test_out"
results: list[tuple[str, bool, str]] = []


class OversizedUploadHandler(BaseHTTPRequestHandler):
    total_bytes = 24 * 1024 * 1024
    bytes_sent = 0

    def do_GET(self):
        type(self).bytes_sent = 0
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        chunk = b"x" * (64 * 1024)
        for _ in range(self.total_bytes // len(chunk)):
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
                type(self).bytes_sent += len(chunk)
                time.sleep(0.001)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                break

    def log_message(self, format, *args):
        return


def check(name: str, condition, detail="") -> None:
    ok = bool(condition)
    results.append((name, ok, str(detail)))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:180] if detail else ""))


def text_of(result):
    try:
        if result.isError:
            return {"_tool_error": result.content[0].text if result.content else "unknown tool error"}
        data = json.loads(result.content[0].text)
        if "error" in data and "result" not in data:
            return data["error"]
        return data
    except Exception as exc:
        print("RAW RESULT:", json.dumps(result.model_dump(), default=str)[:800])
        return {"_parse_error": str(exc)}


def first_index(compact_elements: str) -> int | None:
    match = re.search(r"^\[(\d+)\]", compact_elements or "", re.MULTILINE)
    return int(match.group(1)) if match else None


async def evaluate_over_cdp(cdp_ws, message_id: int, expression: str) -> tuple[int, object]:
    message_id += 1
    await cdp_ws.send(json.dumps({
        "id": message_id,
        "method": "Runtime.evaluate",
        "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
    }))
    while True:
        response = json.loads(await cdp_ws.recv())
        if response.get("id") == message_id:
            if "error" in response or response.get("result", {}).get("exceptionDetails"):
                raise RuntimeError(f"CDP storage update failed: {response}")
            value = response.get("result", {}).get("result", {}).get("value")
            return message_id, value


async def set_enabled_over_cdp(cdp_ws, message_id: int, enabled: bool) -> int:
    expression = f"chrome.storage.local.set({{enabled: {str(enabled).lower()}}}).then(() => true)"
    message_id, _ = await evaluate_over_cdp(cdp_ws, message_id, expression)
    return message_id


async def main() -> int:
    benchmark: dict[str, object] = {}
    async with streamablehttp_client(BRIDGE, headers=bridge_headers()) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            discovered = await session.list_tools()
            names = sorted(tool.name for tool in discovered.tools)
            expected = ["browser_do", "browser_health", "browser_help", "browser_read"]
            check("compact tool discovery", names == expected, names)

            async def call(name: str, arguments: dict):
                return text_of(await session.call_tool(name, arguments))

            async def do(command: str, params: dict | None = None):
                return await call("browser_do", {"command": command, "params": params or {}})

            async def wait_for_connected(expected: bool, timeout: float = 5.0):
                deadline = asyncio.get_running_loop().time() + timeout
                last = None
                while asyncio.get_running_loop().time() < deadline:
                    last = await call("browser_health", {})
                    if isinstance(last, dict) and last.get("extension_connected") is expected:
                        return last
                    await asyncio.sleep(0.1)
                return last

            health = await call("browser_health", {})
            check("health is connected", isinstance(health, dict) and health.get("extension_connected") is True, health)
            check("health omits full tabs", isinstance(health, dict) and "tabs" not in health, health)

            help_index = await call("browser_help", {})
            check("on-demand command help", isinstance(help_index, dict) and "navigate" in help_index.get("commands", ""), help_index)

            nav = await do("navigate", {"url": TEST_URL})
            check("navigate through browser_do", isinstance(nav, dict) and nav.get("url", "").startswith(TEST_URL), nav)

            generated = await do(
                "eval",
                {
                    "js": """(() => {
                      document.getElementById('generated')?.remove();
                      document.getElementById('long-text')?.remove();
                      const host = document.createElement('section');
                      host.id = 'generated';
                      for (let i = 0; i < 120; i++) {
                        const button = document.createElement('button');
                        button.textContent = i === 73 ? 'Needle action' : `Generated action ${i}`;
                        button.setAttribute('aria-label', button.textContent + ' accessible');
                        host.appendChild(button);
                      }
                      document.body.appendChild(host);
                      const p = document.createElement('p');
                      p.id = 'long-text';
                      p.textContent = Array.from({length: 5000}, (_, i) => `segment-${String(i).padStart(4, '0')}`).join(' ');
                      document.body.appendChild(p);
                      const password = document.createElement('input');
                      password.id = 'password-field';
                      password.type = 'password';
                      password.autocomplete = 'current-password';
                      password.value = 'snapshot-secret-must-not-leak';
                      document.body.appendChild(password);
                      const upload = document.createElement('input');
                      upload.id = 'upload-field';
                      upload.type = 'file';
                      document.body.appendChild(upload);
                      return {buttons: 120, textChars: p.textContent.length};
                    })()"""
                },
            )
            check("large fixture injected", isinstance(generated, dict) and generated.get("result", {}).get("buttons") == 120, generated)

            full_snapshot = await do("snapshot", {"format": "full", "max_elements": 500})
            compact_snapshot = await do("snapshot", {"format": "compact", "max_elements": 500})
            full_chars = len(json.dumps(full_snapshot, separators=(",", ":"), ensure_ascii=False))
            compact_chars = len(json.dumps(compact_snapshot, separators=(",", ":"), ensure_ascii=False))
            check("full snapshot has all fixture controls", isinstance(full_snapshot, dict) and full_snapshot.get("total", 0) >= 126, full_snapshot.get("total") if isinstance(full_snapshot, dict) else full_snapshot)
            check("snapshot redacts password values", "snapshot-secret-must-not-leak" not in json.dumps(full_snapshot), "secret absent")
            check("compact snapshot is at most 55% of full JSON", compact_chars <= full_chars * 0.55, f"compact={compact_chars}, full={full_chars}")

            targeted = await call(
                "browser_read",
                {"mode": "snapshot", "query": "Needle action", "max_elements": 10},
            )
            targeted_lines = targeted.get("elements", "") if isinstance(targeted, dict) else ""
            check("query finds one accessible control", targeted.get("element_meta", {}).get("total") == 1, targeted)
            check("query result is actionable", first_index(targeted_lines) is not None and "Needle action" in targeted_lines, targeted_lines)

            page = await call("browser_read", {"mode": "page", "max_chars": 200, "max_elements": 5})
            check("page read bounds text", len(page.get("text", "")) <= 200 and page.get("text_meta", {}).get("truncated") is True, page.get("text_meta") if isinstance(page, dict) else page)
            check("page read bounds elements", len(page.get("elements", "").splitlines()) <= 5 and page.get("element_meta", {}).get("truncated") is True, page.get("element_meta") if isinstance(page, dict) else page)
            second_element_page = await call(
                "browser_read",
                {
                    "mode": "snapshot",
                    "max_elements": 5,
                    "offset": page.get("element_meta", {}).get("next_offset", 0),
                },
            )
            check(
                "snapshot pagination advances",
                second_element_page.get("element_meta", {}).get("returned") == 5
                and second_element_page.get("elements") != page.get("elements"),
                second_element_page.get("element_meta"),
            )

            chunk1 = await do("extract_text", {"selector": "#long-text", "max_chars": 80})
            chunk2 = await do(
                "extract_text",
                {"selector": "#long-text", "max_chars": 80, "offset": chunk1.get("nextOffset", 0)},
            )
            check("text extraction is paginated", len(chunk1.get("text", "")) == 80 and len(chunk2.get("text", "")) == 80 and chunk1.get("nextOffset") == 80, (chunk1, chunk2))
            check("text page chunks advance", chunk1.get("text") != chunk2.get("text"), "chunks differ")

            button_snapshot = await call("browser_read", {"mode": "snapshot", "query": "Click me", "max_elements": 5})
            button_index = first_index(button_snapshot.get("elements", ""))
            clicked = await do("click", {"target": button_index}) if button_index else {}
            counter = await do("eval", {"js": "document.getElementById('result').textContent"})
            check("compact index clicks", clicked.get("clicked") is True and "clicked 1 time" in str(counter.get("result")), (clicked, counter))

            input_snapshot = await call("browser_read", {"mode": "snapshot", "query": "type here", "max_elements": 5})
            input_index = first_index(input_snapshot.get("elements", ""))
            typed = await do("type", {"target": input_index, "text": "hello compact"}) if input_index else {}
            typed_value = await do("eval", {"js": "document.getElementById('inp').value"})
            check("compact index types", typed.get("typed") == 13 and typed_value.get("result") == "hello compact", (typed, typed_value))

            password_snapshot = await call("browser_read", {"mode": "snapshot", "query": "password-field", "max_elements": 5})
            password_index = first_index(password_snapshot.get("elements", ""))
            password_typed = await do("type", {"target": password_index, "text": "typed-secret-must-not-leak"}) if password_index else {}
            password_value = await do("eval", {"js": "document.getElementById('password-field').value"})
            check(
                "password typing does not echo value",
                "typed-secret-must-not-leak" not in json.dumps(password_typed) and password_typed.get("value") == "[REDACTED]",
                password_typed,
            )
            check("password still reaches the DOM intentionally", password_value.get("result") == "typed-secret-must-not-leak", "verified through explicit eval")

            invalid_upload = await do("upload_files", {"files": [{"name": "bad.txt", "url": "data:text/plain,blocked", "type": "text/plain"}]})
            check("upload rejects non-loopback URL", "loopback" in invalid_upload.get("_tool_error", "").lower(), invalid_upload)
            local_upload = await do("upload_files", {"files": [{"name": "index.html", "url": TEST_URL, "type": "text/html"}]})
            uploaded_size = await do("eval", {"js": "document.getElementById('upload-field').files[0].size"})
            check("bounded loopback upload still works", local_upload.get("ok") is True and uploaded_size.get("result", 0) > 0, (local_upload, uploaded_size))
            upload_server = ThreadingHTTPServer(("127.0.0.1", 0), OversizedUploadHandler)
            upload_thread = threading.Thread(target=upload_server.serve_forever, daemon=True)
            upload_thread.start()
            oversized_url = f"http://127.0.0.1:{upload_server.server_port}/oversized.bin"
            try:
                oversized_upload = await do(
                    "upload_files",
                    {"files": [{"name": "oversized.bin", "url": oversized_url}]},
                )
            finally:
                upload_server.shutdown()
                upload_server.server_close()
                upload_thread.join(timeout=2)
            check(
                "streaming upload limit aborts before full body",
                "exceeds" in oversized_upload.get("_tool_error", "").lower()
                and OversizedUploadHandler.bytes_sent < 18 * 1024 * 1024,
                {"result": oversized_upload, "bytes_sent": OversizedUploadHandler.bytes_sent},
            )

            waited = await do("wait_for", {"target": "#btn", "timeout_ms": 2000})
            check("wait_for through browser_do", waited.get("ok") is True, waited)

            screenshot = await do("screenshot")
            screenshot_path = Path(screenshot.get("saved_to", "")) if isinstance(screenshot, dict) and screenshot.get("saved_to") else None
            screenshot_bytes = screenshot_path.read_bytes() if screenshot_path and screenshot_path.is_file() else b""
            check(
                "screenshot saves path without base64",
                screenshot_bytes.startswith(b"\x89PNG") and "dataUrl" not in screenshot,
                screenshot,
            )
            if screenshot_bytes:
                OUT.mkdir(parents=True, exist_ok=True)
                (OUT / "compact-e2e.png").write_bytes(screenshot_bytes)

            tabs = await do("list_tabs")
            tab_items = tabs.get("tabs", []) if isinstance(tabs, dict) else []
            check("tabs through browser_do", len(tab_items) >= 1, f"{len(tab_items)} tabs")
            opened = await do("open_tab", {"url": "https://example.com", "activate": False})
            opened_id = opened.get("id") if isinstance(opened, dict) else None
            check("open tab through browser_do", opened_id is not None, opened)
            if opened_id is not None:
                activated = await do("activate_tab", {"tab_id": opened_id})
                closed = await do("close_tab", {"tab_id": opened_id})
                check("activate tab through browser_do", activated.get("id") == opened_id, activated)
                check("close tab through browser_do", closed.get("closed") == opened_id, closed)

            with urllib.request.urlopen(CDP_HTTP + "/json/list", timeout=5) as response:
                targets = json.load(response)
            worker = None
            for target in targets:
                if target.get("type") != "service_worker" or not target.get("url", "").endswith("/background.js"):
                    continue
                async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2**26) as probe_ws:
                    _, manifest_name = await evaluate_over_cdp(probe_ws, 0, "chrome.runtime.getManifest().name")
                if manifest_name == "Sidecar Monkey":
                    worker = target
                    break
            check("service worker available for settings E2E", worker is not None, worker)
            if worker:
                async with websockets.connect(worker["webSocketDebuggerUrl"], max_size=2**26) as cdp_ws:
                    message_id = await set_enabled_over_cdp(cdp_ws, 0, False)
                    disabled_health = await wait_for_connected(False)
                    check("disable toggle disconnects command channel", disabled_health.get("extension_connected") is False, disabled_health)
                    await set_enabled_over_cdp(cdp_ws, message_id, True)
                    enabled_health = await wait_for_connected(True)
                    check("enable toggle reconnects command channel", enabled_health.get("extension_connected") is True, enabled_health)

            full_text = await do("extract_text", {"max_chars": 200000})
            bounded_text = await call("browser_read", {"mode": "text", "max_chars": 6000})
            default_page_read = await call("browser_read", {})
            legacy_health = dict(health)
            legacy_health["tabs"] = tab_items
            benchmark = {
                "tool_schemas": [tool.model_dump(mode="json") for tool in discovered.tools],
                "calls": {
                    "health": {"arguments": {}, "result": health},
                    "legacy_health": {"arguments": {}, "result": legacy_health},
                    "navigate": {
                        "arguments": {"command": "navigate", "params": {"url": TEST_URL}},
                        "result": nav,
                    },
                    "page_read": {
                        "arguments": {"mode": "page", "max_chars": 200, "max_elements": 5},
                        "result": page,
                    },
                    "default_page_read": {"arguments": {}, "result": default_page_read},
                    "full_snapshot": {
                        "arguments": {"command": "snapshot", "params": {"format": "full", "max_elements": 500}},
                        "result": full_snapshot,
                    },
                    "compact_snapshot": {
                        "arguments": {"command": "snapshot", "params": {"format": "compact", "max_elements": 500}},
                        "result": compact_snapshot,
                    },
                    "targeted_snapshot": {
                        "arguments": {"mode": "snapshot", "query": "Needle action", "max_elements": 10},
                        "result": targeted,
                    },
                    "full_text": {
                        "arguments": {"command": "extract_text", "params": {"max_chars": 200000}},
                        "result": full_text,
                    },
                    "bounded_text": {
                        "arguments": {"mode": "text", "max_chars": 6000},
                        "result": bounded_text,
                    },
                    "targeted_click": {
                        "arguments": {"command": "click", "params": {"target": button_index}},
                        "result": clicked,
                    },
                    "targeted_type": {
                        "arguments": {"command": "type", "params": {"target": input_index, "text": "hello compact"}},
                        "result": typed,
                    },
                    "screenshot": {
                        "arguments": {"command": "screenshot", "params": {}},
                        "result": screenshot,
                    },
                    "list_tabs": {
                        "arguments": {"command": "list_tabs", "params": {}},
                        "result": tabs,
                    },
                },
            }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "compact-token-benchmark.json").write_text(json.dumps(benchmark, ensure_ascii=False), encoding="utf-8")
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

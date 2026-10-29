#!/usr/bin/env python3
"""Run local MCP, raw-CDP and Playwright workflows in an isolated extension-capable test Chrome."""
from __future__ import annotations

import argparse
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def chrome_path(value: str | None) -> Path:
    path = Path(value or Path(tempfile.gettempdir()) / "cft/chrome-win64/chrome.exe").resolve()
    if not path.is_file():
        raise ValueError(f"Test Chrome not found: {path}; supply --chrome or DT_TEST_CHROME")
    if "google/chrome" in path.as_posix().lower():
        raise ValueError("Stable Chrome is unsupported; use Chrome for Testing or Chromium")
    return path


def free_ports() -> tuple[int, int, int, int]:
    with socket.socket() as ws, socket.socket() as http, socket.socket() as cdp, socket.socket() as endpoint:
        for sock in (ws, http, cdp, endpoint):
            sock.bind(("127.0.0.1", 0))
        return ws.getsockname()[1], http.getsockname()[1], cdp.getsockname()[1], endpoint.getsockname()[1]


def fetch_json(url: str):
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.load(response)


async def until(probe, expected, label: str, seconds=15):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            last = await probe()
            if expected(last):
                return last
        except (OSError, TimeoutError):
            pass
        await asyncio.sleep(0.1)
    raise AssertionError(f"{label} timed out: {last!r}")


async def cleanup_temporary(temporary):
    path = Path(temporary.name).resolve()
    if path.parent != Path(tempfile.gettempdir()).resolve() or not path.name.startswith("dt-browser-workflow-"):
        raise ValueError(f"Refusing to clean unexpected temporary path: {path}")
    for attempt in range(20):
        try:
            temporary.cleanup()
            return
        except PermissionError:
            if attempt == 19:
                raise
            await asyncio.sleep(0.25)


async def workflow(mcp_url, cdp_url, site, token, ws_port):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    import websockets
    from e2e_compact_test import text_of, evaluate_over_cdp, set_enabled_over_cdp

    async with streamablehttp_client(mcp_url, headers={"Authorization": f"Bearer {token}"}) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            async def call(name, arguments):
                result = text_of(await asyncio.wait_for(session.call_tool(name, arguments), 25))
                assert isinstance(result, dict) and not result.get("_tool_error") and not result.get("error"), result
                return result

            async def health():
                return await call("browser_health", {})

            await until(health, lambda value: value.get("extension_connected") is True, "extension connection", 40)
            opened = await call("browser_do", {"command": "open_tab", "params": {"url": site + "/index.html"}})
            tab_id = opened["id"]

            async def do(command, **params):
                return await call("browser_do", {"command": command, "params": {**params, "tab_id": tab_id}})

            async def evaluate(js):
                return (await do("eval", js=js))["result"]

            async def state():
                return await evaluate("({workspace: workspaceTrigger.textContent, plain: plain.value, editor: editor.innerText, decoy: decoy.value, status: document.querySelector('#status').textContent, stored: JSON.parse(localStorage.getItem('dt-browser-workflow'))})")

            async def choose(label):
                await do("click", target="#workspaceTrigger")
                snapshot = await do("snapshot", selector="#workspaceOptions", format="full", max_elements=10)
                options = snapshot["elements"]
                assert [item["text"] for item in options if item["role"] == "option"] == ["Blue team", "Blue team (archived)", "Green team"], options
                option = next(item for item in options if item["text"] == label and item["role"] == "option")
                if label == "Green team":
                    assert option["inViewport"] is False, option
                await do("click", target=option["index"])
                assert (await state())["workspace"] == label

            replacement = "  café e\u0301 中文 العربية 👩🏽‍💻\n\n" + "\n".join(f'\tLine {i}: "quoted" <markup> & Ω — keep  two spaces 🦊' for i in range(90)) + "\nFinal line"

            async def fill():
                for selector, key in [("#plain", "plain"), ("#editor", "editor")]:
                    await do("type", target=selector, text="Obsolete content must disappear")
                    await do("click", target="#decoy")
                    assert await evaluate("document.activeElement.id") == "decoy"
                    await do("type", target=selector, text=replacement)
                    await do("click", target="#decoy")
                    actual = await state()
                    assert actual[key] == replacement and actual["decoy"] == "Leave this unchanged", key

            try:
                await do("wait_for", target="#inp", timeout_ms=3000)
                await do("type", target="#inp", text="Local MCP fixture ✓")
                assert await evaluate("document.querySelector('#inp').value") == "Local MCP fixture ✓"
                await do("navigate", url=site + "/workflow.html")
                await do("wait_for", target="#workspaceTrigger", timeout_ms=3000)
                assert (await state())["status"] == "Not saved"
                await choose("Blue team (archived)")
                assert await evaluate("workspaceOptions.parentElement === document.body && workspaceTrigger.getAttribute('aria-controls') === 'workspaceOptions'")
                await choose("Blue team")
                await choose("Green team")
                await choose("Blue team")
                print("PASS MCP portal dropdown and offscreen option", flush=True)
                await fill()
                print("PASS MCP exact multiline Unicode replacement after focus loss", flush=True)
                await do("click", target="#inertSave")
                actual = await state()
                assert actual["stored"] is None and actual["status"] == "Preview only — changes not persisted", actual
                await do("reload")
                await do("wait_for", target="#plain", timeout_ms=3000)
                actual = await state()
                assert actual["stored"] is None and actual["plain"] == "Original plain text" and actual["status"] == "Not saved", actual
                await choose("Blue team")
                await fill()
                await do("click", target="#save")
                await until(state, lambda value: value["status"] == "Saved revision 1", "asynchronous save", 4)
                saved = {"workspace": "Blue team", "plain": replacement, "editor": replacement, "revision": 1}
                assert (await state())["stored"] == saved
                await do("reload")
                await do("wait_for", target="#plain", timeout_ms=3000)
                assert await state() == {"workspace": "Blue team", "plain": replacement, "editor": replacement, "decoy": "Leave this unchanged", "status": "Saved revision 1", "stored": saved}
                print("PASS MCP inert preview and durable asynchronous save", flush=True)
                targets = await asyncio.to_thread(fetch_json, cdp_url + "/json/list")
                workers = [target for target in targets if target.get("type") == "service_worker" and target.get("url", "").endswith("/background.js")]
                owned, probe_errors = [], []
                identity_js = "({name: chrome.runtime.getManifest().name, bridgePort: typeof DTB_DEFAULTS === 'undefined' ? null : DTB_DEFAULTS.bridgePort})"
                expected_identity = {"name": "Sidecar Monkey", "bridgePort": ws_port}
                for candidate in workers:
                    try:
                        async with websockets.connect(candidate["webSocketDebuggerUrl"], open_timeout=5) as probe:
                            _, identity = await asyncio.wait_for(evaluate_over_cdp(probe, 0, identity_js), 5)
                        if identity == expected_identity:
                            owned.append(candidate)
                    except Exception as error:
                        probe_errors.append(f"{candidate['url']}: {error}")
                assert len(owned) == 1, {"owned": owned, "probe_errors": probe_errors}
                async with websockets.connect(owned[0]["webSocketDebuggerUrl"], open_timeout=5) as worker:
                    message_id, identity = await asyncio.wait_for(evaluate_over_cdp(worker, 0, identity_js), 5)
                    assert identity == expected_identity, identity
                    message_id = await asyncio.wait_for(set_enabled_over_cdp(worker, message_id, False), 5)
                    await until(health, lambda value: value.get("extension_connected") is False, "extension disable")
                    await asyncio.wait_for(set_enabled_over_cdp(worker, message_id, True), 5)
                    await until(health, lambda value: value.get("extension_connected") is True, "extension reconnect", 40)
                assert (await state())["stored"] == saved
                print("PASS extension disable/re-enable reconnect", flush=True)
            finally:
                await do("close_tab", tab_id=tab_id)


async def run(chrome):
    sys.path.insert(0, str(ROOT / "bridge"))
    os.environ.pop("DT_BRIDGE_EXTENSION_ID", None)
    import bridge
    import cdp_endpoint

    files = {"/index.html": (ROOT / "test_site/index.html").read_bytes(),
             "/workflow.html": (ROOT / "jev-harness/bench/site/workflow.html").read_bytes()}

    class Fixture(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except (ConnectionResetError, ConnectionAbortedError):
                pass  # Chrome closes unused preconnect sockets during owned-process cleanup.

        def do_GET(self):
            body = files.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body if body is not None else b"Not found")

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ws_port, http_port, cdp_port, endpoint_port = free_ports()
    token = secrets.token_hex(32)
    controller = bridge.Controller(token)
    bridge.run_ws_thread(controller, ws_port)
    bridge.run_http(bridge.build_mcp(controller), http_port, token)
    cdp_endpoint.run_cdp_thread(endpoint_port, f"ws://127.0.0.1:{ws_port}", token)
    site, cdp_url = f"http://127.0.0.1:{server.server_port}", f"http://127.0.0.1:{cdp_port}"
    log_path = ROOT / "test_out/browser-workflow-chrome.log"
    log_path.parent.mkdir(exist_ok=True)
    process = None
    try:
        temporary_directory = tempfile.TemporaryDirectory(prefix="dt-browser-workflow-")
        with temporary_directory as temporary:
            extension = Path(temporary) / "extension"
            shutil.copytree(ROOT / "extension", extension)
            settings_file = extension / "settings.js"
            settings = settings_file.read_text(encoding="utf-8")
            for old, new in [("  token: '',", f"  token: '{token}',"), ("  bridgePort: 18765,", f"  bridgePort: {ws_port},")]:
                assert settings.count(old) == 1, f"Expected exactly one copied settings default: {old}"
                settings = settings.replace(old, new)
            settings_file.write_text(settings, encoding="utf-8")
            with log_path.open("wb") as log:
                process = subprocess.Popen([str(chrome), "--headless=new", "--window-size=1280,900",
                    f"--user-data-dir={Path(temporary) / 'profile'}", f"--remote-debugging-port={cdp_port}",
                    "--remote-debugging-address=127.0.0.1", f"--disable-extensions-except={extension}",
                    f"--load-extension={extension}", "--no-first-run", "--no-default-browser-check",
                    "--disable-background-networking", "--disable-sync", "--disable-component-update", "about:blank"],
                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
                print(f'Chrome log: Get-Content "{log_path}" -Wait -Tail 40', flush=True)
                try:
                    await until(lambda: asyncio.to_thread(fetch_json, cdp_url + "/json/version"), bool, "Chrome CDP")
                    await until(lambda: asyncio.to_thread(fetch_json, f"http://127.0.0.1:{http_port}/health"), bool, "MCP HTTP")
                    await workflow(f"http://127.0.0.1:{http_port}/mcp", cdp_url, site, token, ws_port)
                    environment = {**os.environ, "DT_BROWSER_E2E": "1", "DT_BRIDGE_TOKEN": token,
                                   "JEV_BRIDGE": f"ws://127.0.0.1:{ws_port}", "BENCH_SITE": site}
                    completed = await asyncio.to_thread(subprocess.run, ["node", "--test", "--test-concurrency=1",
                        "test/relay_live.test.js", "test/workflow.test.js"],
                        cwd=ROOT / "jev-harness", env=environment, timeout=360, check=False,
                        stdout=sys.stdout, stderr=subprocess.STDOUT)
                    assert completed.returncode == 0, f"Relay tests failed: {completed.returncode}"
                    # Playwright is not a project dependency: a global install is found through NODE_PATH.
                    node_path = os.environ.get("NODE_PATH") or subprocess.run(
                        ["npm", "root", "-g"], capture_output=True, text=True, check=True, shell=os.name == "nt").stdout.strip()
                    completed = await asyncio.to_thread(subprocess.run, ["node", str(ROOT / "scripts/playwright_cdp_check.cjs"),
                        f"http://127.0.0.1:{endpoint_port}", site], env={**environment, "NODE_PATH": node_path},
                        timeout=120, check=False, stdout=sys.stdout, stderr=subprocess.STDOUT)
                    assert completed.returncode == 0, f"Playwright check failed: {completed.returncode}"
                finally:
                    if process.poll() is None:
                        try:
                            import websockets
                            browser = await asyncio.to_thread(fetch_json, cdp_url + "/json/version")
                            async with websockets.connect(browser["webSocketDebuggerUrl"], open_timeout=3) as socket:
                                await socket.send(json.dumps({"id": 1, "method": "Browser.close"}))
                                try:
                                    await asyncio.wait_for(socket.recv(), 3)
                                except websockets.ConnectionClosed:
                                    pass
                        except (OSError, TimeoutError):
                            pass
                        try:
                            await asyncio.to_thread(process.wait, timeout=10)
                        except subprocess.TimeoutExpired:
                            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15, check=True)
                            process.wait(timeout=10)
                    await cleanup_temporary(temporary_directory)
    finally:
        server.shutdown()
        server.server_close()
    print("PASS isolated MCP, raw-CDP and Playwright browser workflows", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", default=os.environ.get("DT_TEST_CHROME"), help="Chrome for Testing or explicit Chromium executable; never stable Chrome")
    args = parser.parse_args()
    try:
        asyncio.run(asyncio.wait_for(run(chrome_path(args.chrome)), 480))
    except (Exception, KeyboardInterrupt) as error:
        print(f"FAIL {type(error).__name__}: {error}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

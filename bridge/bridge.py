#!/usr/bin/env python3
"""dt-browser bridge.

Three listeners in one process:

  * WebSocket server  ws://127.0.0.1:18765    <- the Chrome extension connects here
  * MCP server        http://127.0.0.1:18899/mcp  <- Hermes Agent CLI + Desktop connect here
                                                     (or stdio with --stdio)
  * CDP endpoint      http://127.0.0.1:18922  <- Playwright connectOverCDP (cdp_endpoint.py)

MCP tools are thin wrappers that relay JSON commands over the extension's
WebSocket and wait for the response. The extension is the only client of the
WS server; Hermes is the only consumer of the MCP side.

Run:  uv run python bridge.py [--ws-port 18765] [--http-port 18899] [--no-auth] [--stdio]
The token comes from DT_BRIDGE_TOKEN or bridge/token.txt (never the command line, which other
processes can read). It never crosses either socket in the clear: WS clients and the bridge prove
they hold it with HMAC over each other's nonces, and MCP HTTP callers send it as a bearer header.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import math
import os
import re
import secrets
import sys
import threading
import time
from concurrent.futures import Future
from logging.handlers import RotatingFileHandler

from mcp.server.fastmcp import FastMCP  # type: ignore[import-untyped]
from mcp.server.fastmcp.server import Settings as FastMCPSettings

# FastMCP's Settings declares `lifespan` with a forward reference to FastMCP. Resolve it before
# pydantic-settings inspects the field, or every start warns about an incomplete definition.
FastMCPSettings.model_rebuild()

from cdp_endpoint import run_cdp_thread
from hermes_proc import any_hermes_instance

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

log = logging.getLogger("dt-browser")

HERE = os.path.dirname(os.path.abspath(__file__))
EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}$")
# DT_BRIDGE_EXTENSION_ID pins the one extension allowed to take the extension role (its id is on
# chrome://extensions); unset, any extension origin that also proves the token is accepted.
PINNED_EXTENSION_ID = os.environ.get("DT_BRIDGE_EXTENSION_ID", "").strip()
WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
WS_AUTH_TIMEOUT_SECONDS = 5.0
MAX_RELAY_TIMEOUT_SECONDS = 120.0
CDP_ATTACH_COMMANDS = {"cdp_open", "cdp_attach"}
CDP_OWNED_COMMANDS = {"cdp_send", "cdp_detach", "cdp_close"}
RELAY_EVENT_SEND_TIMEOUT_SECONDS = 2.0
RELAY_EVENT_QUEUE = 2000  # events buffered per relay before it counts as not reading
RELAY_SLOTS_PER_CLIENT = 8
CDP_GONE_MAX = 256
# What each authenticated client role may ask the extension to do. jev-harness ("relay") only
# needs raw CDP on tabs it attaches; relay_cmd.py ("hermes-cli") is the MCP tools' command line.
RELAY_COMMANDS = {"relay": {"ping", "list_tabs", "cdp_open", "cdp_attach", "cdp_send", "cdp_detach", "cdp_close"}}

def proof(token: str, label: str, nonce: str) -> str:
    """HMAC-SHA256(token, "<label>:<nonce>") as hex: shows the token is held without sending it.
    Empty under --no-auth (no token): WebCrypto refuses a zero-length HMAC key."""
    if not token:
        return ""
    return hmac.new(token.encode("utf-8"), f"{label}:{nonce}".encode("utf-8"), "sha256").hexdigest()


def valid_nonce(value) -> bool:
    return isinstance(value, str) and 16 <= len(value) <= 128 and value.isascii()

PARAM_ALIASES = {
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs",
    "max_chars": "maxChars",
    "max_elements": "maxElements",
    "viewport_only": "viewportOnly",
    "include_geometry": "includeGeometry",
    "save_path": "savePath",
    "include_data_url": "includeDataUrl",
    "press_enter": "pressEnter",
    "interval_s": "intervalS",
}
COMMAND_SPECS = {
    "list_tabs": {"params": "none", "required": (), "timeout": 15.0},
    "open_tab": {"params": "url, activate?", "required": ("url",), "timeout": 20.0},
    "close_tab": {"params": "tab_id", "required": ("tabId",), "timeout": 20.0},
    "create_tab": {"params": "url?, name?, activate?", "required": (), "timeout": 20.0},
    "remove_tab": {"params": "tab_id?, name?", "required": (), "timeout": 20.0},
    "name_tab": {"params": "name, tab_id?", "required": ("name",), "timeout": 20.0},
    "list_named_tabs": {"params": "none", "required": (), "timeout": 15.0},
    "switch_tab": {"params": "target", "required": ("target",), "timeout": 20.0},
    "activate_tab": {"params": "tab_id", "required": ("tabId",), "timeout": 20.0},
    "navigate": {"params": "url, tab_id?, wait_load?", "required": ("url",), "timeout": 60.0},
    "get_state": {"params": "tab_id?", "required": (), "timeout": 20.0},
    "get_element_state": {"params": "target, tab_id?", "required": ("target",), "timeout": 20.0},
    "snapshot": {"params": "tab_id?, format?, query?, selector?, max_elements?, offset?, viewport_only?, include_geometry?", "required": (), "timeout": 20.0},
    "click": {"params": "target, double?, tab_id?", "required": ("target",), "timeout": 20.0},
    "hover": {"params": "target, tab_id?", "required": ("target",), "timeout": 20.0},
    "select_option": {"params": "target, value?, label?, tab_id?", "required": ("target",), "timeout": 20.0},
    "type": {"params": "target, text, clear?, press_enter?, tab_id?", "required": ("target", "text"), "timeout": 20.0},
    "press": {"params": "key, tab_id?", "required": ("key",), "timeout": 20.0},
    "scroll": {"params": "direction?, amount?, target?, tab_id?", "required": (), "timeout": 20.0},
    "extract_text": {"params": "tab_id?, selector?, max_chars?, offset?", "required": (), "timeout": 20.0},
    "export_html": {"params": "tab_id?, selector?, outer?, max_chars?, save_path?", "required": (), "timeout": 25.0},
    "loop_check": {"params": "condition?, target?, expected?, interval_s?, count?, timeout?, tab_id?", "required": (), "timeout": 300.0},
    "screenshot": {"params": "tab_id?, save_path?, include_data_url?", "required": (), "timeout": 30.0},
    "eval": {"params": "js, tab_id?", "required": ("js",), "timeout": 20.0},
    "upload_files": {"params": "files, tab_id?", "required": ("files",), "timeout": 120.0},
    "wait_for": {"params": "target, timeout_ms?, tab_id?", "required": ("target",), "timeout": 25.0},
    "back": {"params": "tab_id?", "required": (), "timeout": 25.0},
    "forward": {"params": "tab_id?", "required": (), "timeout": 25.0},
    "reload": {"params": "tab_id?", "required": (), "timeout": 25.0},
}


def temp_dir(name: str) -> str:
    import tempfile

    temp_root = tempfile.gettempdir()
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        temp_root = os.path.join(os.environ["LOCALAPPDATA"], "Temp")
    path = os.path.join(temp_root, name)
    os.makedirs(path, exist_ok=True)
    return path


def screenshot_dir() -> str:
    return temp_dir("dt-browser-screenshots")


def export_dir() -> str:
    return temp_dir("dt-browser-exports")


def confined_path(save_path: str, folder: str, ext: str) -> str:
    """save_path inside folder: a bare name or a path under it, with ext appended if missing.
    Anything else is refused, so an MCP caller cannot overwrite arbitrary files with page content."""
    root = os.path.realpath(folder)
    full = os.path.realpath(os.path.join(root, save_path))
    if os.path.commonpath([root, full]) != root or full == root:
        raise ValueError(f"save_path must be a file name inside {root}")
    if not full.lower().endswith(ext):
        full += ext
    os.makedirs(os.path.dirname(full), exist_ok=True)
    return full


class Controller:
    """Thread-safe relay between MCP tools (any thread) and the extension WS (its own thread)."""

    def __init__(self, token: str):
        self.token = token
        self.extension_info: dict | None = None
        self._ws = None
        self._ws_loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self._pending: dict[int, Future] = {}
        self._next_id = 0
        # Raw-CDP tabs (cdp_open/cdp_attach) -> the relay client that owns them: its
        # events go only there, and only it may send to, detach or close the tab.
        self._cdp_owners: dict[int, object] = {}
        self._cdp_attaching: dict[int, object] = {}
        # Tabs whose debugger detached before any relay claimed them (closed right after attach).
        self._cdp_gone: dict[int, None] = {}  # insertion-ordered set, capped at CDP_GONE_MAX
        self._relays: set = set()  # authenticated relay sockets: they keep the bridge alive

    # ---- raw-CDP ownership ----
    def cdp_owner(self, tab_id):
        with self._lock:
            return self._cdp_owners.get(tab_id)

    def cdp_reserve(self, tab_id):
        if not isinstance(tab_id, int) or isinstance(tab_id, bool):
            raise ValueError("tabId (integer) is required")
        with self._lock:
            if tab_id in self._cdp_owners or tab_id in self._cdp_attaching:
                raise RuntimeError(f"tab {tab_id} is already attached or attaching")
            reservation = self._cdp_attaching[tab_id] = object()
            self._cdp_gone.pop(tab_id, None)
            return reservation

    def cdp_unreserve(self, tab_id, reservation) -> None:
        with self._lock:
            if self._cdp_attaching.get(tab_id) is reservation:
                del self._cdp_attaching[tab_id]

    def cdp_can_cleanup(self, tab_id, reservation=None) -> bool:
        with self._lock:
            return tab_id not in self._cdp_owners and self._cdp_attaching.get(tab_id) is reservation

    def cdp_claim(self, tab_id, ws, reservation=None) -> bool:
        with self._lock:
            if tab_id in self._cdp_owners or self._cdp_attaching.get(tab_id) is not reservation:
                return False
            if tab_id in self._cdp_gone:
                del self._cdp_gone[tab_id]
                return False
            self._cdp_owners[tab_id] = ws
            return True

    def cdp_release(self, tab_id) -> None:
        with self._lock:
            if self._cdp_owners.pop(tab_id, None) is None:
                self._cdp_gone[tab_id] = None
                while len(self._cdp_gone) > CDP_GONE_MAX:
                    del self._cdp_gone[next(iter(self._cdp_gone))]

    def cdp_release_all(self, ws) -> list:
        with self._lock:
            tabs = [t for t, owner in self._cdp_owners.items() if owner is ws]
            for t in tabs:
                del self._cdp_owners[t]
        return tabs

    def cdp_release_every(self) -> list:
        with self._lock:
            items = list(self._cdp_owners.items())
            self._cdp_owners.clear()
            self._cdp_attaching.clear()
            self._cdp_gone.clear()
        return items

    def relay_added(self, ws) -> None:
        with self._lock:
            self._relays.add(ws)

    def relay_removed(self, ws) -> None:
        with self._lock:
            self._relays.discard(ws)

    def relay_active(self) -> bool:
        """A connected relay (jev-harness attaches per call, so it is often between tabs)."""
        with self._lock:
            return bool(self._relays) or bool(self._cdp_owners)

    # ---- WS thread side ----
    def replace_ws(self, ws, loop):
        with self._lock:
            previous = self._ws
            displaced = []
            if previous is not None and previous is not ws:
                displaced = list(self._pending.values())
                self._pending.clear()
            self._ws = ws
            self._ws_loop = loop
        for future in displaced:
            if not future.done():
                future.set_exception(RuntimeError("extension connection replaced"))
        return previous

    def get_ws(self):
        with self._lock:
            return self._ws

    def get_extension_info(self):
        with self._lock:
            return self.extension_info

    def on_ws_message(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "response" and "id" in msg:
            with self._lock:
                fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                if msg.get("ok"):
                    fut.set_result(msg.get("result"))
                else:
                    fut.set_exception(RuntimeError(msg.get("error") or "extension error (no detail)"))

    def on_ws_close(self) -> None:
        with self._lock:
            self.extension_info = None
            pend = list(self._pending.values())
            self._pending.clear()
        for f in pend:
            if not f.done():
                f.set_exception(RuntimeError("extension disconnected — is the bridge/extension still up?"))

    # ---- MCP thread side ----
    def _register_command(self):
        with self._lock:
            ws, loop = self._ws, self._ws_loop
            if ws is None or loop is None:
                raise RuntimeError(
                    "no browser connected — open Chrome, make sure the Sidecar Monkey "
                    "extension is loaded, and check its popup shows 'connected'"
                )
            self._next_id += 1
            mid = self._next_id
            fut: Future = Future()
            self._pending[mid] = fut
            return ws, loop, mid, fut

    def send_command(self, cmd: str, params: dict | None = None, timeout: float = 30.0, *, on_timeout=None):
        ws, loop, mid, fut = self._register_command()
        payload = json.dumps({"type": "command", "id": mid, "cmd": cmd, "params": params or {}})
        try:
            asyncio.run_coroutine_threadsafe(ws.send(payload), loop).result(timeout=10)
        except Exception as e:  # send failed
            if isinstance(e, TimeoutError) and on_timeout is not None:
                on_timeout(fut)
            else:
                with self._lock:
                    self._pending.pop(mid, None)
            detail = str(e) or type(e).__name__
            raise RuntimeError(f"failed to send '{cmd}' to extension: {detail}") from e
        try:
            return fut.result(timeout=timeout)
        except Exception as e:
            if isinstance(e, TimeoutError) and on_timeout is not None:
                # Attach may complete after its caller stops waiting; keep its reply for cleanup.
                on_timeout(fut)
            else:
                with self._lock:
                    self._pending.pop(mid, None)
            detail = str(e) or type(e).__name__
            raise RuntimeError(f"browser command '{cmd}' failed: {detail}") from e

    async def send_in_order(self, cmd: str, params: dict | None = None, timeout: float = 30.0):
        """send_command for the WebSocket loop itself. No worker thread, so commands reach the
        extension in the order they were issued: CDP clients pipeline them (Playwright sends a
        mouse press and its release back to back, and swapped they are no click)."""
        ws, _loop, mid, fut = self._register_command()
        try:
            await ws.send(json.dumps({"type": "command", "id": mid, "cmd": cmd, "params": params or {}}))
            return await asyncio.wait_for(asyncio.wrap_future(fut), timeout)
        except Exception as e:
            with self._lock:
                self._pending.pop(mid, None)
            detail = str(e) or type(e).__name__
            raise RuntimeError(f"browser command '{cmd}' failed: {detail}") from e


def execute_loop_check(ctl: Controller, params: dict, default_timeout: float = 120.0) -> dict:
    condition = str(params.get("condition") or "text_contains").lower()
    target = params.get("target")
    expected = str(params.get("expected") or "")
    interval_s = max(0.1, float(params.get("intervalS") or params.get("interval_s") or 2.0))
    count = int(params.get("count") or 0)
    # The caller's limit (the command spec, or the relay's 120 s cap) is a ceiling, not a default.
    timeout = min(float(params.get("timeout") or default_timeout), default_timeout)
    tab_id = params.get("tabId") if params.get("tabId") is not None else params.get("tab_id")

    start_time = time.time()
    deadline = start_time + timeout
    attempt = 0
    last_text = None
    stable_count = 0

    while time.time() < deadline:
        attempt += 1
        elapsed = round(time.time() - start_time, 2)
        matched = False
        current_val = None

        if condition in {"text_contains", "text_matches", "text_stable"}:
            if target:
                res = ctl.send_command("extract_text", {"selector": target, "tabId": tab_id}, timeout=15)
            else:
                res = ctl.send_command("extract_text", {"tabId": tab_id, "maxChars": 60000}, timeout=15)
            current_val = res.get("text") or ""
            if condition == "text_contains":
                matched = expected.lower() in current_val.lower() if expected else bool(current_val)
            elif condition == "text_matches":
                matched = bool(re.search(expected, current_val, re.IGNORECASE))
            elif condition == "text_stable":
                if current_val == last_text and current_val:
                    stable_count += 1
                    if stable_count >= 2:
                        matched = True
                else:
                    stable_count = 0
                last_text = current_val

        elif condition in {"element_exists", "element_visible", "element_gone"}:
            if not target:
                raise ValueError("loop_check with element condition requires 'target'")
            res = ctl.send_command("get_element_state", {"target": target, "tabId": tab_id}, timeout=15)
            exists = bool(isinstance(res, dict) and res.get("ok") is True)
            if not exists and not (isinstance(res, dict) and str(res.get("error", "")).startswith("no element matches selector:")):
                raise RuntimeError(f"loop_check element query failed: {res.get('error') if isinstance(res, dict) else res}")
            visible = bool(exists and res.get("visible") is True)
            if condition == "element_exists":
                matched = exists
                current_val = exists
            elif condition == "element_visible":
                matched = visible
                current_val = visible
            elif condition == "element_gone":
                matched = not visible
                current_val = not visible

        elif condition == "eval":
            if not expected:
                raise ValueError("loop_check with 'eval' condition requires JS expression in 'expected'")
            res = ctl.send_command("eval", {"js": expected, "tabId": tab_id}, timeout=15)
            if res.get("ok") is False:
                # e.g. page CSP forbids unsafe-eval: surface it instead of a bare timeout
                raise RuntimeError(f"loop_check eval failed: {res.get('error') or res}")
            current_val = res.get("result")
            matched = bool(current_val)

        else:
            raise ValueError(f"unknown loop_check condition: {condition!r}")

        if matched:
            return {
                "ok": True,
                "condition_met": True,
                "condition": condition,
                "attempts": attempt,
                "elapsed_s": elapsed,
                "value": current_val[:300] if isinstance(current_val, str) else current_val,
            }

        if count > 0 and attempt >= count:
            return {
                "ok": True,
                "condition_met": False,
                "condition": condition,
                "attempts": attempt,
                "elapsed_s": elapsed,
                "value": current_val[:300] if isinstance(current_val, str) else current_val,
                "message": f"Completed {count} checks without condition being met",
            }

        remaining = deadline - time.time()
        if remaining <= 0:
            break
        time.sleep(min(interval_s, remaining))

    return {
        "ok": False,
        "condition_met": False,
        "condition": condition,
        "attempts": attempt,
        "elapsed_s": round(time.time() - start_time, 2),
        "error": f"Timed out after {timeout}s waiting for {condition} ({expected!r})",
    }


def build_mcp(ctl: Controller) -> FastMCP:
    from mcp.server.transport_security import TransportSecuritySettings

    # Explicit, not the library default: no Origin header is allowed at all (no browser page may
    # call this endpoint; Hermes and scripts send none), and only loopback Host names.
    mcp = FastMCP("dt-browser", transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"],
        allowed_origins=[],
    ))

    def save_screenshot_result(res: dict, save_path: str | None) -> dict:
        if not save_path or not res.get("dataUrl"):
            return res
        import base64

        try:
            save_path = confined_path(save_path, screenshot_dir(), ".png")
            b64 = res["dataUrl"].split(",", 1)[-1]
            with open(save_path, "wb") as f:
                f.write(base64.b64decode(b64))
            res["saved_to"] = save_path
        except Exception as e:
            # a file-write failure must not discard the successful capture
            res["saved_to"] = None
            res["save_error"] = str(e)
        return res

    @mcp.tool()
    def browser_health(include_tabs: bool = False) -> dict:
        """Connection health, tab count, and active tab. Set include_tabs only when the full tab inventory is needed."""
        ws = ctl.get_ws()
        if ws is None:
            return {"extension_connected": False, "hint": "open Chrome, load the extension, check its popup"}
        try:
            tabs = ctl.send_command("list_tabs", timeout=15)
            result = {
                "extension_connected": True,
                "extension": ctl.get_extension_info(),
                "tab_count": len(tabs) if isinstance(tabs, list) else None,
            }
            if isinstance(tabs, list):
                active = next((tab for tab in tabs if tab.get("active")), None)
                if active:
                    result["active_tab"] = {
                        key: active.get(key)
                        for key in ("id", "windowId", "title", "url")
                        if key in active
                    }
                if include_tabs:
                    result["tabs"] = tabs
            return result
        except Exception as e:
            return {"extension_connected": True, "error": str(e)}

    @mcp.tool()
    def browser_read(
        mode: str = "page",
        query: str | None = None,
        selector: str | None = None,
        max_chars: int = 6000,
        max_elements: int = 60,
        offset: int = 0,
        viewport_only: bool = False,
        include_geometry: bool = False,
        tab_id: int | None = None,
    ) -> dict:
        """Token-bounded page read.
        mode=page: visible text plus compact actionable elements;
        text: visible page text;
        snapshot: compact element list;
        screenshot: captures screenshot to disk and returns image path for AI vision;
        elements: structured JSON array of interactive elements;
        html: clean page HTML.
        query filters elements, selector scopes the DOM, and offset paginates.
        """
        if mode not in {"page", "text", "snapshot", "screenshot", "elements", "html"}:
            raise ValueError("mode must be page, text, snapshot, screenshot, elements, or html")
        if not 0 <= max_chars <= 500_000:
            raise ValueError("max_chars must be between 0 and 500000")
        if not 0 <= max_elements <= 5000:
            raise ValueError("max_elements must be between 0 and 5000")
        if offset < 0:
            raise ValueError("offset must be non-negative")
        if mode == "screenshot":
            save_path = confined_path(f"screenshot-{time.time_ns()}.png", screenshot_dir(), ".png")
            res = ctl.send_command("screenshot", {"tabId": tab_id}, timeout=30.0)
            saved = save_screenshot_result(res, save_path)
            path = saved.get("saved_to")
            return {
                "ok": bool(path),
                "mode": "screenshot",
                "tabId": saved.get("tabId"),
                "saved_to": path,
                "screenshot_path": path,
                "mime": "image/png",
                **({"hint": "Image saved to disk. Pass saved_to to vision_analyze(image_url=...) to inspect."} if path else
                   {"save_error": saved.get("save_error") or "screenshot returned no image data"}),
            }
        return ctl.send_command(
            "read",
            {
                "mode": mode,
                "query": query,
                "selector": selector,
                "maxChars": max_chars,
                "maxElements": max_elements,
                "offset": offset,
                "viewportOnly": viewport_only,
                "includeGeometry": include_geometry,
                "tabId": tab_id,
            },
            timeout=20,
        )

    @mcp.tool()
    def browser_do(command: str, params: dict | None = None) -> dict:
        """Run one browser command with snake_case params. Use browser_help for the on-demand command/parameter catalog; use browser_read for bounded page inspection."""
        spec = COMMAND_SPECS.get(command)
        if spec is None:
            raise ValueError(f"unknown browser command {command!r}; call browser_help")
        normalized = dict(params or {})
        for snake, camel in PARAM_ALIASES.items():
            if snake not in normalized:
                continue
            if camel in normalized and normalized[camel] != normalized[snake]:
                raise ValueError(f"conflicting values for {snake} and {camel}")
            normalized[camel] = normalized.pop(snake)
        missing = [name for name in spec["required"] if name not in normalized]
        if missing:
            readable = [next((snake for snake, camel in PARAM_ALIASES.items() if camel == name), name) for name in missing]
            raise ValueError(f"{command} requires: {', '.join(readable)}")
        save_path = None
        include_data_url = False
        if command == "screenshot":
            save_path = normalized.pop("save_path", None) or normalized.pop("savePath", None)
            include_data_url = (normalized.pop("include_data_url", None) or normalized.pop("includeDataUrl", False)) is True
            save_path = confined_path(save_path or f"screenshot-{time.time_ns()}.png", screenshot_dir(), ".png")
        custom_save = None
        if command == "export_html":
            raw_save = normalized.pop("save_path", None) or normalized.pop("savePath", None)
            if raw_save:
                custom_save = confined_path(raw_save, export_dir(), ".html")
        timeout = float(spec["timeout"])
        if command == "wait_for":
            try:
                timeout = max(0.0, float(normalized.get("timeoutMs", 10_000))) / 1000 + 15
            except (TypeError, ValueError) as e:
                raise ValueError("timeout_ms must be numeric") from e
        if command == "loop_check":
            return execute_loop_check(ctl, normalized, default_timeout=timeout)
        result = ctl.send_command(command, normalized, timeout=timeout)
        if command == "list_tabs" and isinstance(result, list):
            result = {"tabs": result}
        if command == "screenshot":
            result = save_screenshot_result(result, save_path)
            if not include_data_url and result.get("saved_to"):
                result.pop("dataUrl", None)
                result["data_url_omitted"] = True
        if custom_save and isinstance(result, dict) and result.get("ok"):
            try:
                with open(custom_save, "w", encoding="utf-8") as f:
                    f.write(result.get("html") or "")
                result["saved_to"] = custom_save
            except Exception as e:
                result["save_error"] = str(e)
        return result

    @mcp.tool()
    def browser_help(command: str | None = None) -> dict:
        """Return the browser_do command catalog, or exact params for one command. This keeps detailed schemas out of every model turn."""
        if command is None:
            lines = [f"{name}({spec['params']})" for name, spec in COMMAND_SPECS.items()]
            return {"usage": "browser_do(command, params)", "commands": "\n".join(lines)}
        spec = COMMAND_SPECS.get(command)
        if spec is None:
            raise ValueError(f"unknown browser command {command!r}")
        return {"command": command, "params": spec["params"], "required": list(spec["required"])}

    return mcp


async def ws_main(ctl: Controller, ws_port: int, ready: Future | None = None) -> None:
    import websockets
    from websockets.protocol import State

    loop = asyncio.get_running_loop()

    def _asyncio_exception_handler(current_loop: asyncio.AbstractEventLoop, context: dict) -> None:
        exception = context.get("exception")
        if isinstance(exception, ConnectionResetError) and getattr(exception, "winerror", None) == 10054:
            return  # Benign connection reset on Windows when client drops abruptly
        current_loop.default_exception_handler(context)

    loop.set_exception_handler(_asyncio_exception_handler)

    relay_slots: dict = {}  # relay ws -> its own Semaphore: one stuck client cannot starve the others
    relay_queues: dict = {}  # relay ws -> its outgoing CDP event queue, drained by its own writer
    relay_writers: dict = {}  # relay ws -> that writer task, cancelled when the relay goes

    async def reject_auth(ws, reason: str, code: int = 4003) -> None:
        try:
            await ws.send(json.dumps({"type": "auth_fail", "reason": reason}))
            await ws.close(code=code, reason=reason[:120])
        except Exception:
            pass

    def relay_timeout(value) -> float:
        try:
            timeout = float(value)
        except (TypeError, ValueError) as e:
            raise ValueError("timeout must be numeric") from e
        if not math.isfinite(timeout) or not 0.1 <= timeout <= MAX_RELAY_TIMEOUT_SECONDS:
            raise ValueError(f"timeout must be between 0.1 and {MAX_RELAY_TIMEOUT_SECONDS:g} seconds")
        return timeout

    relay_tasks: set[asyncio.Task] = set()

    def spawn(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        relay_tasks.add(task)
        task.add_done_callback(relay_tasks.discard)
        return task

    async def detach_unowned(tab_id, reservation=None) -> None:
        if not ctl.cdp_can_cleanup(tab_id, reservation):
            return
        try:
            await asyncio.to_thread(ctl.send_command, "cdp_detach", {"tabId": tab_id}, 10.0)
        except Exception:
            pass

    async def cleanup_late_attach(future, tab_id, reservation, extension) -> None:
        try:
            try:
                result = await asyncio.wait_for(asyncio.wrap_future(future), MAX_RELAY_TIMEOUT_SECONDS)
                if tab_id is None:
                    tab_id = result["tabId"]
            except TimeoutError:
                # A silent extension cannot retain pending attachments indefinitely.
                await extension.close(code=4008, reason="attachment response timeout")
            except Exception:
                pass
            if tab_id is not None:
                await detach_unowned(tab_id, reservation)
        finally:
            if reservation is not None:
                ctl.cdp_unreserve(tab_id, reservation)

    async def relay_writer(ws, queue: asyncio.Queue) -> None:
        # Events go out in order from this task, never from the extension's receive loop, so a
        # slow relay cannot hold up Hermes responses queued behind its events.
        while True:
            raw = await queue.get()
            try:
                await asyncio.wait_for(ws.send(raw), RELAY_EVENT_SEND_TIMEOUT_SECONDS)
            except Exception:
                await ws.close(code=4009, reason="relay not reading events")
                return

    def forward_event(owner, raw: str) -> None:
        # Bounded: a relay that stops reading is dropped; its close handler detaches its tabs.
        queue = relay_queues.get(owner)
        if queue is None:
            return
        try:
            queue.put_nowait(raw)
        except asyncio.QueueFull:
            relay_queues.pop(owner, None)
            writer = relay_writers.pop(owner, None)
            if writer is not None:
                writer.cancel()
            spawn(owner.close(code=4009, reason="relay not reading events"))

    async def run_relay_command(ws, role: str, msg) -> None:
        # send_command runs in a worker thread — it blocks on
        # run_coroutine_threadsafe().result(), which would deadlock this ws loop
        # and starve the extension's response.
        cmd, params = msg.get("cmd"), msg.get("params") or {}
        reservation = None
        late_cleanup = False
        try:
            timeout = relay_timeout(msg.get("timeout", MAX_RELAY_TIMEOUT_SECONDS))
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
            allowed = RELAY_COMMANDS.get(role)
            if allowed is not None and cmd not in allowed:
                raise RuntimeError(f"{cmd!r} is not available to a {role} client")
            tab_id = params.get("tabId")
            if cmd in CDP_OWNED_COMMANDS and ctl.cdp_owner(tab_id) is not ws:
                raise RuntimeError(f"tab {tab_id} is not attached by this client")
            try:
                async with relay_slots[ws]:
                    if cmd == "cdp_attach":
                        reservation = ctl.cdp_reserve(tab_id)
                    extension = ctl.get_ws()

                    def attach_timed_out(future):
                        nonlocal late_cleanup
                        late_cleanup = True
                        loop.call_soon_threadsafe(spawn, cleanup_late_attach(future, tab_id, reservation, extension))

                    if cmd == "loop_check":
                        # loop_check is a poll loop the bridge runs itself over extension
                        # primitives; forwarding it to the extension fails with
                        # "unknown command". Same routing as the MCP tool path.
                        res = await asyncio.to_thread(execute_loop_check, ctl, params, timeout)
                    elif cmd in CDP_ATTACH_COMMANDS:
                        res = await asyncio.to_thread(ctl.send_command, cmd, params, timeout, on_timeout=attach_timed_out)
                    else:
                        res = await ctl.send_in_order(cmd, params, timeout)
            except Exception:
                if reservation is not None and not late_cleanup:
                    await detach_unowned(tab_id, reservation)
                raise
            if cmd in CDP_ATTACH_COMMANDS:
                # The relay may have gone while the attach ran; its close handler has
                # already released its tabs, so this one would stay attached for good.
                if ws.state is not State.OPEN or not ctl.cdp_claim(res["tabId"], ws, reservation):
                    await detach_unowned(res["tabId"], reservation)
                    raise RuntimeError(f"tab {res['tabId']} closed or its client left while attaching")
            elif cmd in ("cdp_detach", "cdp_close"):
                ctl.cdp_release(tab_id)
            reply = {"type": "response", "id": msg.get("id"), "ok": True, "result": res}
        except Exception as e:
            reply = {"type": "response", "id": msg.get("id"), "ok": False, "error": str(e) or type(e).__name__}
        finally:
            if reservation is not None and not late_cleanup:
                ctl.cdp_unreserve(tab_id, reservation)
        try:
            await ws.send(json.dumps(reply))
        except Exception:
            pass  # client disconnected mid-command

    async def handler(ws):
        loop = asyncio.get_running_loop()
        authed = False
        is_extension = False
        role = None
        auth_deadline = loop.time() + WS_AUTH_TIMEOUT_SECONDS
        request = getattr(ws, "request", None)
        origin = request.headers.get("Origin") if request is not None else None
        log.info("new WebSocket connection from %s", ws.remote_address)
        # Mutual proof of the token: the client answers this nonce, the bridge answers the
        # client's. A process squatting on the port learns nothing and cannot pass as the bridge.
        challenge = secrets.token_hex(16)
        try:
            await ws.send(json.dumps({"type": "hello", "nonce": challenge, "version": 2}))
            while True:
                try:
                    if authed:
                        raw = await ws.recv()
                    else:
                        remaining = auth_deadline - loop.time()
                        if remaining <= 0:
                            raise TimeoutError
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except TimeoutError:
                    await ws.close(code=4008, reason="authentication timeout")
                    return
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "auth":
                    if authed:
                        await reject_auth(ws, "already authenticated")
                        return
                    client_nonce = msg.get("nonce")
                    if not valid_nonce(client_nonce):
                        await reject_auth(ws, "auth needs a nonce (update the client: protocol version 2)")
                        return
                    claimed = msg.get("proof")
                    if ctl.token and not (isinstance(claimed, str) and claimed.isascii()
                                          and hmac.compare_digest(claimed, proof(ctl.token, "client", challenge))):
                        log.warning("rejected connection: bad token proof")
                        await reject_auth(ws, "bad token", code=4001)
                        return
                    extension_role = (
                        msg.get("extension") == "dt-browser"
                        and msg.get("version") == 2
                        and msg.get("client") is None
                    )
                    relay_role = (
                        msg.get("client") in {"relay", "hermes-cli"}
                        and msg.get("extension") is None
                    )
                    ok = json.dumps({"type": "auth_ok", "proof": proof(ctl.token, "bridge", client_nonce)})
                    extension_origin = bool(origin and EXTENSION_ORIGIN_RE.fullmatch(origin)) and (
                        not PINNED_EXTENSION_ID or origin == f"chrome-extension://{PINNED_EXTENSION_ID}")
                    if extension_role and extension_origin:
                        previous = ctl.replace_ws(ws, loop)
                        if previous is not None and previous is not ws:
                            for tab_id, owner in ctl.cdp_release_every():
                                forward_event(owner, json.dumps({"type": "event", "tabId": tab_id, "method": "Inspector.detached", "params": {"reason": "extension_replaced"}}))
                        is_extension = True
                        with ctl._lock:
                            ctl.extension_info = {"extension": msg["extension"], "version": msg["version"]}
                        await ws.send(ok)
                        log.info("extension authenticated: %s", ctl.extension_info)
                        if previous is not None and previous is not ws:
                            await previous.close(code=4002, reason="extension connection replaced")
                    elif relay_role and origin is None:
                        role = msg["client"]
                        relay_slots[ws] = asyncio.Semaphore(RELAY_SLOTS_PER_CLIENT)
                        queue = relay_queues[ws] = asyncio.Queue(RELAY_EVENT_QUEUE)
                        relay_writers[ws] = spawn(relay_writer(ws, queue))
                        ctl.relay_added(ws)
                        await ws.send(ok)
                        log.info("%s client authenticated", role)
                    else:
                        await reject_auth(ws, "invalid client role or origin")
                        return
                    authed = True
                elif authed and is_extension:
                    if ctl.get_ws() is not ws:
                        continue
                    if msg.get("type") == "event":
                        # Queued in order per relay: it must read e.g. requestWillBeSent
                        # before the loadingFinished that follows it.
                        owner = ctl.cdp_owner(msg.get("tabId"))
                        if msg.get("method") == "Inspector.detached":
                            ctl.cdp_release(msg.get("tabId"))
                        if owner is not None:
                            forward_event(owner, raw)
                    else:
                        ctl.on_ws_message(raw)
                elif authed:
                    # relay client: each command runs as its own task, so a raw-CDP
                    # client can keep many calls in flight (one slow call does not
                    # hold up the rest).
                    if msg.get("type") == "command" and msg.get("id") is not None:
                        spawn(run_relay_command(ws, role, msg))
                    elif msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                # unauthenticated non-auth messages: ignored (a local socket must
                # not be able to resolve pending futures before authenticating)
        except websockets.ConnectionClosed:
            pass
        except Exception:
            log.exception("WebSocket handler failed")
        finally:
            if role is not None:
                ctl.relay_removed(ws)
                relay_slots.pop(ws, None)
                relay_queues.pop(ws, None)
                writer = relay_writers.pop(ws, None)
                if writer is not None:
                    writer.cancel()
                # A relay that disconnects leaves no tab under the debugging banner.
                for tab_id in ctl.cdp_release_all(ws):
                    await detach_unowned(tab_id)
            # Ownership guard: only the handler that CURRENTLY owns the slot may
            # clear it. Without this, a stale handler's finally can wipe a newer
            # connection (close+immediate-reconnect races) and fail its futures.
            with ctl._lock:
                owns_slot = ctl._ws is ws
                if owns_slot:
                    ctl._ws = None
                    ctl._ws_loop = None
            if owns_slot:
                ctl.on_ws_close()
                # The extension detaches every debuggee when its socket drops; tell
                # each owning relay so its tab reads as closed rather than failing on.
                for tab_id, owner in ctl.cdp_release_every():
                    detached = {"type": "event", "tabId": tab_id, "method": "Inspector.detached", "params": {"reason": "extension_disconnected"}}
                    forward_event(owner, json.dumps(detached))
                log.info("extension disconnected")

    async def serve():
        async with websockets.serve(
            handler,
            "127.0.0.1",
            ws_port,
            origins=[None, EXTENSION_ORIGIN_RE],
            max_size=WS_MAX_MESSAGE_BYTES,
            max_queue=4,
        ):
            if ready is not None:
                ready.set_result(None)
            log.info("WebSocket listening on ws://127.0.0.1:%d", ws_port)
            await asyncio.Future()  # run forever

    await serve()


def run_ws_thread(ctl: Controller, ws_port: int) -> threading.Thread:
    ready: Future = Future()

    def target():
        try:
            asyncio.run(ws_main(ctl, ws_port, ready))
        except Exception as e:
            if not ready.done():
                ready.set_exception(e)
            else:
                log.exception("WebSocket server stopped")

    t = threading.Thread(target=target, daemon=True, name="ws-server")
    t.start()
    ready.result(timeout=10)
    return t


def run_http(mcp: FastMCP, http_port: int, token: str) -> threading.Thread:
    """Serve the MCP app (mounted at /mcp) plus a /health probe via uvicorn in a thread."""
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Mount, Route
    import uvicorn

    mcp_app = mcp.streamable_http_app()
    app = Starlette(
        routes=[
            Route("/health", lambda r: JSONResponse({"ok": True})),
            Mount("/", app=bearer_auth(mcp_app, token)),  # FastMCP serves /mcp; mount at root avoids 307 redirects
        ],
        lifespan=mcp_app.router.lifespan_context,  # FastMCP needs its lifespan (session state) to run
    )

    def target():
        uvicorn.run(app, host="127.0.0.1", port=http_port, log_level="info", access_log=False)

    t = threading.Thread(target=target, daemon=True, name="mcp-http")
    t.start()
    return t


def bearer_auth(app, token: str):
    """ASGI wrapper: every MCP request needs `Authorization: Bearer <token>` (none with --no-auth).
    Loopback alone is not a boundary: any local process could otherwise drive the browser."""
    if not token:
        return app
    expected = f"Bearer {token}".encode("utf-8")

    async def wrapped(scope, receive, send):
        if scope["type"] == "http":
            given = dict(scope.get("headers") or []).get(b"authorization", b"")
            if not hmac.compare_digest(given, expected):
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"text/plain"), (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": b"missing or wrong bearer token"})
                return
        await app(scope, receive, send)

    return wrapped


def wait_http_listening(thread: threading.Thread, port: int, seconds: float = 10.0) -> bool:
    """uvicorn's bind error ends only its own thread; without this check the process would run on
    WS-only while Hermes sees connection refused."""
    import socket

    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and thread.is_alive():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.2)
    else:
        return False
    # Another process may already be listening on the port: then uvicorn's bind fails and its
    # thread ends a moment after this connection succeeded.
    time.sleep(1.0)
    return thread.is_alive()


class TolerantRotatingFileHandler(RotatingFileHandler):
    """Windows cannot rename a log another process holds open (Get-Content -Wait does): keep writing
    to the current file and retry the rollover a minute later instead of erroring on every record."""

    retry_at = 0.0

    def shouldRollover(self, record) -> bool:
        return time.monotonic() >= self.retry_at and bool(super().shouldRollover(record))

    def doRollover(self) -> None:
        try:
            super().doRollover()
        except PermissionError:
            self.retry_at = time.monotonic() + 60
            if self.stream is None:
                self.stream = self._open()


def _resolve_token(args) -> str:
    """Token precedence: DT_BRIDGE_TOKEN env > bridge/token.txt > auto-generate.
    token.txt (gitignored) makes the token the standing default for every start path. There is no
    command-line flag: other processes can read a command line."""
    if args.no_auth:
        return ""
    env = os.environ.get("DT_BRIDGE_TOKEN", "")
    if env:
        return env
    tf = os.path.join(HERE, "token.txt")
    try:
        with open(tf, encoding="utf-8") as f:
            t = f.read().strip()
        if t:
            return t
    except OSError:
        pass
    token = secrets.token_hex(32)
    try:
        fd = os.open(tf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token + "\n")
    except FileExistsError:
        with open(tf, encoding="utf-8") as f:
            existing = f.read().strip()
        if existing:
            return existing
        raise RuntimeError(f"token file exists but is empty: {tf}")
    return token


def hermes_lifecycle_watch(ctl: Controller, interval: float = 15.0, grace_misses: int = 2) -> threading.Thread:
    """Exit the bridge ~grace_misses*interval after the LAST Hermes desktop/CLI
    instance closes (HTTP mode only; stdio mode is Hermes-owned so it dies with
    its client naturally).  The always-on gateway does not count as an instance;
    a connected relay client (jev-harness) does, attached to a tab or not."""
    def target():
        misses = 0
        while True:
            time.sleep(interval)
            if any_hermes_instance() or ctl.relay_active():
                misses = 0
                continue
            misses += 1
            log.info("no Hermes desktop/CLI instance (miss %d/%d); shutting down", misses, grace_misses)
            if misses >= grace_misses:
                os._exit(0)

    t = threading.Thread(target=target, daemon=True, name="hermes-lifecycle")
    t.start()
    return t


def main() -> int:
    ap = argparse.ArgumentParser(description="dt-browser bridge: Chrome extension <-> Hermes MCP")
    ap.add_argument("--ws-port", type=int, default=int(os.environ.get("DT_BRIDGE_WS_PORT", "18765")))
    ap.add_argument("--http-port", type=int, default=int(os.environ.get("DT_BRIDGE_HTTP_PORT", "18899")))
    ap.add_argument("--cdp-port", type=int, default=int(os.environ.get("DT_BRIDGE_CDP_PORT", "18922")),
                    help="Chrome DevTools endpoint for Playwright connectOverCDP (0 = off)")
    ap.add_argument("--no-auth", action="store_true", help="accept any localhost connection (dev convenience)")
    ap.add_argument("--stdio", action="store_true", help="run the MCP side over stdio instead of HTTP (for hermes mcp add)")
    ap.add_argument("--no-lifecycle", action="store_true", help="stay up even with no Hermes desktop/CLI instance (debug)")
    ap.add_argument("--show-token", action="store_true", help="print the configured token for explicit pairing")
    args = ap.parse_args()
    if args.no_auth and os.environ.get("DT_BRIDGE_ALLOW_NO_AUTH") != "1":
        ap.error("--no-auth lets any local process and any extension drive the browser; "
                 "set DT_BRIDGE_ALLOW_NO_AUTH=1 as well to confirm (isolated development only)")

    token = _resolve_token(args)
    ctl = Controller(token)

    # In stdio mode stdout is the MCP JSON-RPC channel — logs must go to stderr
    # (or file), never stdout.
    handlers = [logging.StreamHandler(sys.stderr)]
    if not args.stdio:
        handlers.append(TolerantRotatingFileHandler(os.path.join(HERE, "bridge.log"), maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )
    logging.getLogger("uvicorn").setLevel(logging.WARNING)

    mcp = build_mcp(ctl)

    banner = [
        "dt-browser bridge starting",
        f"  WebSocket (extension): ws://127.0.0.1:{args.ws_port}",
    ]
    if args.stdio:
        banner.append("  MCP transport: stdio")
    else:
        banner.append(f"  MCP (Hermes):       http://127.0.0.1:{args.http_port}/mcp")
        banner.append(f"  health:             http://127.0.0.1:{args.http_port}/health")
    for line in banner:
        log.info(line)
    if args.cdp_port:
        try:
            run_cdp_thread(args.cdp_port, f"ws://127.0.0.1:{args.ws_port}", token)
        except (OSError, TimeoutError) as e:
            # Playwright access is an add-on: Hermes and jev-harness still work without it.
            log.error("CDP endpoint did not start on 127.0.0.1:%d: %s", args.cdp_port, e)
    log.info("auth: %s", "token configured" if token else "none (localhost only)")
    if args.show_token:
        print(f"auth token: {token}" if token else "auth: none (localhost only)", file=sys.stderr, flush=True)
        if token:
            print("-> paste this token into the extension popup (token field)", file=sys.stderr, flush=True)

    if args.stdio:
        try:
            run_ws_thread(ctl, args.ws_port)
        except (OSError, TimeoutError) as e:
            log.error("WebSocket server did not start: %s", e)
            return 1
        mcp.run(transport="stdio")
        return 0

    http_thread = run_http(mcp, args.http_port, token)
    if not wait_http_listening(http_thread, args.http_port):
        log.error("MCP HTTP server did not start on 127.0.0.1:%d (port busy or reserved?); exiting", args.http_port)
        return 1
    if not args.no_lifecycle:
        hermes_lifecycle_watch(ctl)
        log.info(
            "lifecycle: exiting ~30s after the last Hermes desktop/CLI instance closes "
            "(gateway does not count; a connected jev-harness does)"
        )
    try:
        asyncio.run(ws_main(ctl, args.ws_port))
    except KeyboardInterrupt:
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

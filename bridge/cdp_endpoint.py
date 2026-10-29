#!/usr/bin/env python3
"""Chrome DevTools endpoint over the dt-browser relay, for Playwright and other CDP clients.

    chromium.connectOverCDP("http://127.0.0.1:18922", {headers: {Authorization: "Bearer <token>"}})

drives the user's real, signed-in Chrome through the extension's chrome.debugger. Each client
connection is one relay client of the bridge, so the bridge's tab ownership rules hold: the client
sees only tabs it opens (Target.createTarget, i.e. context.newPage()), popups those tabs open, and
the user's tabs named with ?tab=<id> (ids from /json/list). Everything else is the root-session
emulation Playwright's own extension relay does (playwright-core src/tools/mcp/cdpRelayV2.ts):
browser-level commands go through any attached tab, and there is one browser context.
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import threading
from concurrent.futures import Future
from urllib.parse import parse_qs, urlsplit

import websockets
from websockets.asyncio.server import serve

from relay_cmd import authenticate

log = logging.getLogger("dt-browser")

PAGE_SESSION = "dtb-tab-"
COMMAND_TIMEOUT_SECONDS = 120.0  # the bridge's own cap on a relay command
BROWSER_PRODUCT = "Chrome/dt-browser"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


class Session:
    """One CDP client (Playwright) <-> one authenticated relay connection to the bridge."""

    def __init__(self, client, bridge, requested_tabs: list[int]):
        self.client = client
        self.bridge = bridge
        self.requested_tabs = requested_tabs
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 0
        self.tabs: dict[int, dict] = {}  # attached tabId -> {"info": targetInfo, "owned": bool}
        self.children: dict[str, int] = {}  # flat child session (OOPIF, worker) -> its tabId
        self.gone: set[int] = set()  # tabs that detached while still being attached
        self.auto_attach = False
        self.tasks: set[asyncio.Task] = set()

    def spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def emit(self, message: dict) -> None:
        try:
            await self.client.send(json.dumps(message))
        except websockets.ConnectionClosed:
            pass

    async def command(self, cmd: str, params: dict) -> dict:
        self.next_id += 1
        cid = self.next_id
        future = self.pending[cid] = asyncio.get_running_loop().create_future()
        try:
            await self.bridge.send(json.dumps({"type": "command", "id": cid, "cmd": cmd, "params": params, "timeout": COMMAND_TIMEOUT_SECONDS}))
            reply = await asyncio.wait_for(future, COMMAND_TIMEOUT_SECONDS + 15)
        finally:
            self.pending.pop(cid, None)
        if not reply.get("ok"):
            raise RuntimeError(reply.get("error") or f"{cmd} failed")
        return reply.get("result") or {}

    async def attach(self, tab_id: int | None = None, url: str | None = None, own: bool = False) -> dict:
        if tab_id is None:
            res = await self.command("cdp_open", {"url": url} if url else {})
        else:
            res = await self.command("cdp_attach", {"tabId": tab_id, "own": own})
        tab = res["tabId"]
        try:
            info = (await self.command("cdp_send", {"tabId": tab, "method": "Target.getTargetInfo"}))["targetInfo"]
            # cdp_open reuses a tab a relay client opened before; a new page must not start on its old URL.
            if url and info.get("url") != url:
                await self.command("cdp_send", {"tabId": tab, "method": "Page.navigate", "params": {"url": url}})
                info["url"] = url
            # Its Inspector.detached came before the tab was ours to report: never announce it.
            if tab in self.gone:
                raise RuntimeError(f"tab {tab} closed while attaching")
        except Exception:
            with contextlib.suppress(Exception):  # already released if the tab is gone
                await self.command("cdp_detach", {"tabId": tab})
            raise
        finally:
            self.gone.discard(tab)
        self.tabs[tab] = {"info": info, "owned": bool(res.get("owned"))}
        await self.emit({"method": "Target.attachedToTarget", "params": {
            "sessionId": f"{PAGE_SESSION}{tab}", "targetInfo": {**info, "attached": True}, "waitingForDebugger": False}})
        return info

    async def detached(self, tab: int) -> None:
        entry = self.tabs.pop(tab, None)
        if entry is None:
            return
        for child in [s for s, t in self.children.items() if t == tab]:
            del self.children[child]
        await self.emit({"method": "Target.detachedFromTarget", "params": {
            "sessionId": f"{PAGE_SESSION}{tab}", "targetId": entry["info"].get("targetId")}})

    async def on_event(self, msg: dict) -> None:
        tab, method, params = msg.get("tabId"), msg.get("method"), msg.get("params") or {}
        if tab not in self.tabs:
            if method == "Inspector.detached" and not msg.get("sessionId"):
                self.gone.add(tab)  # mid-attach: the bridge forwards only tabs this client holds
            return
        if method == "dtb.tabOpened":
            if self.auto_attach:
                self.spawn(self.attach_quietly(params.get("tabId")))
            return
        if method == "Inspector.detached" and not msg.get("sessionId"):  # the tab itself
            await self.detached(tab)
            return
        child = params.get("sessionId")
        if method == "Target.attachedToTarget" and child:
            self.children[child] = tab
        elif method == "Target.detachedFromTarget" and child:
            self.children.pop(child, None)
        await self.emit({"sessionId": msg.get("sessionId") or f"{PAGE_SESSION}{tab}", "method": method, "params": params})

    async def attach_quietly(self, tab_id) -> None:
        try:
            await self.attach(tab_id=tab_id, own=True)
        except Exception as e:  # another debugger may hold the popup; the client just never sees it
            log.info("cdp endpoint: popup tab %s not attached: %s", tab_id, e)

    def target_of(self, session: str) -> dict:
        if session.startswith(PAGE_SESSION):
            try:
                tab = int(session[len(PAGE_SESSION):])
            except ValueError:
                tab = None
            if tab in self.tabs:
                return {"tabId": tab}
        elif session in self.children:
            return {"tabId": self.children[session], "sessionId": session}
        raise RuntimeError(f"no attached target for session {session}")

    async def dispatch(self, session: str | None, method: str, params: dict):
        if session:
            return await self.command("cdp_send", {**self.target_of(session), "method": method, "params": params})
        if method == "Browser.getVersion":
            return {"protocolVersion": "1.3", "product": BROWSER_PRODUCT, "revision": "", "userAgent": BROWSER_PRODUCT, "jsVersion": ""}
        if method == "Browser.setDownloadBehavior":
            return {}  # downloads land where the user's Chrome puts them
        if method == "Target.setAutoAttach":
            self.auto_attach = True
            for tab in self.requested_tabs:
                if tab not in self.tabs:
                    await self.attach(tab_id=tab)
            return {}
        if method == "Target.getTargetInfo":
            return {"targetInfo": {"targetId": "browser", "type": "browser", "title": "", "url": "", "attached": True, "canAccessOpener": False}}
        if method == "Target.createTarget":
            return {"targetId": (await self.attach(url=params.get("url") or "about:blank")).get("targetId")}
        if method == "Target.closeTarget":
            tab = next((t for t, e in self.tabs.items() if e["info"].get("targetId") == params.get("targetId")), None)
            if tab is None:
                return {"success": False}
            # The user's own tabs are only let go, never closed.
            await self.command("cdp_close" if self.tabs[tab]["owned"] else "cdp_detach", {"tabId": tab})
            await self.detached(tab)
            return {"success": True}
        if not self.tabs:
            raise RuntimeError(f"{method} needs an attached tab: open a page first")
        # Browser-scoped commands (Storage.getCookies, ...) answer the same through any tab.
        return await self.command("cdp_send", {"tabId": next(iter(self.tabs)), "method": method, "params": params})

    async def handle(self, msg: dict) -> None:
        session = msg.get("sessionId")
        try:
            params = msg.get("params") or {}
            if not isinstance(msg.get("method"), str) or not isinstance(params, dict):
                raise ValueError("a CDP command needs a method and object params")
            reply = {"id": msg.get("id"), "result": await self.dispatch(session, msg["method"], params)}
        except Exception as e:
            reply = {"id": msg.get("id"), "error": {"code": -32000, "message": str(e) or type(e).__name__}}
        if session:
            reply["sessionId"] = session
        await self.emit(reply)

    async def read_bridge(self) -> None:
        async for raw in self.bridge:
            msg = json.loads(raw)
            if msg.get("type") == "response":
                future = self.pending.get(msg.get("id"))
                if future is not None and not future.done():
                    future.set_result(msg)
            elif msg.get("type") == "event":
                await self.on_event(msg)

    async def read_client(self) -> None:
        async for raw in self.client:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict):
                # A task per command (one slow call must not hold the rest); each sends to the
                # bridge before its first real await, so commands still leave in arrival order.
                self.spawn(self.handle(msg))


def requested_tabs(query: str) -> list[int]:
    return [int(t) for value in parse_qs(query).get("tab", []) for t in value.split(",") if t.strip()]


async def serve_endpoint(port: int, bridge_url: str, token: str, ready: Future | None = None) -> None:
    def authorized(request) -> bool:
        if not token:
            return True
        return hmac.compare_digest(request.headers.get("Authorization", "").encode(), f"Bearer {token}".encode())

    def json_reply(connection, body):
        response = connection.respond(200, json.dumps(body))
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = "application/json"
        return response

    async def list_tabs() -> list:
        async with websockets.connect(bridge_url, max_size=2**26) as bridge:
            await authenticate(bridge, token, "relay")
            await bridge.send(json.dumps({"type": "command", "id": 1, "cmd": "list_tabs", "params": {}, "timeout": 10}))
            while True:
                msg = json.loads(await asyncio.wait_for(bridge.recv(), 25))
                if msg.get("type") == "response":
                    if not msg.get("ok"):
                        raise RuntimeError(msg.get("error"))
                    return [{"id": t["id"], "type": "page", "title": t.get("title"), "url": t.get("url"), "active": t.get("active")}
                            for t in msg["result"]]

    async def process_request(connection, request):
        # Web pages can reach loopback too; only local programs holding the token get in.
        if request.headers.get("Origin") is not None:
            return connection.respond(403, "browser origins are not allowed\n")
        # Against DNS rebinding, which a same-origin GET (no Origin) would otherwise get through.
        if request.headers.get("Host", "").rsplit(":", 1)[0] not in LOOPBACK_HOSTS:
            return connection.respond(403, "loopback Host only\n")
        if not authorized(request):
            return connection.respond(401, "send Authorization: Bearer <dt-browser bridge token>\n")
        parts = urlsplit(request.path)
        path = parts.path.rstrip("/")
        try:
            requested_tabs(parts.query)
        except ValueError:
            return connection.respond(400, "tab must be an integer tab id (see /json/list)\n")
        if path == "/json/version":
            query = f"?{parts.query}" if parts.query else ""
            return json_reply(connection, {"Browser": BROWSER_PRODUCT, "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/browser/dt-browser{query}"})
        if path in ("/json", "/json/list"):
            try:
                return json_reply(connection, await list_tabs())
            except Exception as e:
                return connection.respond(502, f"bridge: {e}\n")
        if path.startswith("/devtools/browser"):
            return None  # the WebSocket handshake
        return connection.respond(404, "not found\n")

    async def handler(client) -> None:
        bridge = None
        try:
            bridge = await websockets.connect(bridge_url, max_size=2**26)
            await authenticate(bridge, token, "relay")
        except Exception as e:
            log.warning("cdp endpoint: bridge unavailable: %s", e)
            if bridge is not None:
                await bridge.close()
            await client.close(code=1011, reason=f"bridge unavailable: {e}"[:120])
            return
        session = Session(client, bridge, requested_tabs(urlsplit(client.request.path).query))
        log.info("cdp endpoint: client connected")
        reader = asyncio.create_task(session.read_bridge())
        try:
            done, _ = await asyncio.wait([reader, asyncio.create_task(session.read_client())], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.cancelled() and task.exception() and not isinstance(task.exception(), websockets.ConnectionClosed):
                    log.warning("cdp endpoint: session ended: %s", task.exception())
        finally:
            for task in [reader, *session.tasks]:
                task.cancel()
            # Closing the relay makes the bridge detach every tab this client held.
            await bridge.close()
            await client.close()
            log.info("cdp endpoint: client disconnected")

    async with serve(handler, "127.0.0.1", port, process_request=process_request, max_size=2**26):
        if ready is not None:
            ready.set_result(None)
        log.info("CDP endpoint (Playwright connectOverCDP): http://127.0.0.1:%d", port)
        await asyncio.Future()


def run_cdp_thread(port: int, bridge_url: str, token: str) -> threading.Thread:
    ready: Future = Future()

    def target():
        try:
            asyncio.run(serve_endpoint(port, bridge_url, token, ready))
        except Exception as e:
            if not ready.done():
                ready.set_exception(e)
            else:
                log.exception("CDP endpoint stopped")

    t = threading.Thread(target=target, daemon=True, name="cdp-endpoint")
    t.start()
    ready.result(timeout=10)
    return t

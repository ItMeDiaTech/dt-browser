"""bridge/cdp_endpoint.py against a fake bridge: the CDP a Playwright client sees, and the relay
commands that reach the bridge for it."""
from __future__ import annotations

import asyncio
import json
import socket
import sys
import unittest
import urllib.error
import urllib.request
from concurrent.futures import Future
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

import cdp_endpoint  # noqa: E402
from relay_cmd import proof  # noqa: E402

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
INFO = {7: {"targetId": "T7", "type": "page", "url": "https://old.test/"}, 5: {"targetId": "T5", "type": "page", "url": "https://user.test/"},
        9: {"targetId": "T9", "type": "page", "url": "about:blank", "openerId": "T7"}}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeBridge:
    """Speaks the bridge's relay side: handshake v2, then answers commands like the extension."""

    def __init__(self):
        self.commands: list[tuple[str, dict]] = []
        self.sockets = []
        self.closed = asyncio.Event()
        self.before_reply = None  # async (ws, cmd, params): runs before the extension's answer

    async def handler(self, ws):
        await ws.send(json.dumps({"type": "hello", "nonce": "n" * 32, "version": 2}))
        auth = json.loads(await ws.recv())
        assert auth["client"] == "relay" and auth["proof"] == proof(TOKEN, "client", "n" * 32)
        await ws.send(json.dumps({"type": "auth_ok", "proof": proof(TOKEN, "bridge", auth["nonce"])}))
        self.sockets.append(ws)
        try:
            async for raw in ws:
                msg = json.loads(raw)
                cmd, p = msg["cmd"], msg["params"]
                self.commands.append((cmd, p))
                if self.before_reply:
                    await self.before_reply(ws, cmd, p)
                result = {
                    "cdp_open": lambda: {"tabId": 7, "targetId": "T7", "owned": True, "created": False},
                    "cdp_attach": lambda: {"tabId": p["tabId"], "targetId": INFO[p["tabId"]]["targetId"], "owned": p.get("own", False)},
                    "list_tabs": lambda: [{"id": 5, "title": "Mail", "url": "https://user.test/", "active": True}],
                }.get(cmd, lambda: {"targetInfo": dict(INFO[p["tabId"]])} if p.get("method") == "Target.getTargetInfo" else {"echo": p})()
                await ws.send(json.dumps({"type": "response", "id": msg["id"], "ok": True, "result": result}))
        finally:
            self.closed.set()

    async def event(self, tab, method, params, session=None):
        await self.sockets[-1].send(json.dumps({"type": "event", "tabId": tab, "sessionId": session, "method": method, "params": params}))


class CdpEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake = FakeBridge()
        bridge_port, self.port = free_port(), free_port()
        self.server = await serve(self.fake.handler, "127.0.0.1", bridge_port).__aenter__()
        ready = Future()
        self.endpoint = asyncio.create_task(cdp_endpoint.serve_endpoint(self.port, f"ws://127.0.0.1:{bridge_port}", TOKEN, ready))
        await asyncio.wrap_future(ready)
        self.base = f"http://127.0.0.1:{self.port}"

    async def asyncTearDown(self):
        self.endpoint.cancel()
        self.server.close()
        await self.server.wait_closed()

    def get(self, path, headers=AUTH):
        request = urllib.request.Request(self.base + path, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None

    async def test_http_needs_the_token_and_no_browser_origin(self):
        self.assertEqual((await asyncio.to_thread(self.get, "/json/version", {}))[0], 401)
        self.assertEqual((await asyncio.to_thread(self.get, "/json/version", {**AUTH, "Origin": "https://evil.test"}))[0], 403)
        self.assertEqual((await asyncio.to_thread(self.get, "/json/version", {**AUTH, "Host": f"rebound.test:{self.port}"}))[0], 403)
        self.assertEqual((await asyncio.to_thread(self.get, "/json/version/?tab=x"))[0], 400)
        status, body = await asyncio.to_thread(self.get, "/json/version/?tab=5")
        self.assertEqual(status, 200)
        self.assertEqual(body["webSocketDebuggerUrl"], f"ws://127.0.0.1:{self.port}/devtools/browser/dt-browser?tab=5")
        self.assertEqual(await asyncio.to_thread(self.get, "/json/list"), (200, [{"id": 5, "type": "page", "title": "Mail", "url": "https://user.test/", "active": True}]))
        with self.assertRaises(websockets.InvalidStatus):
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/devtools/browser/x"):
                pass

    async def test_playwright_session_maps_onto_relay_commands(self):
        async with websockets.connect(f"ws://127.0.0.1:{self.port}/devtools/browser/x?tab=5", additional_headers=AUTH) as pw:
            next_id = iter(range(1, 100))
            inbox: list[dict] = []

            async def until(predicate):
                while not (found := [m for m in inbox if predicate(m)]):
                    inbox.append(json.loads(await asyncio.wait_for(pw.recv(), 5)))
                inbox.remove(found[0])
                return found[0]

            async def call(method, params=None, session=None):
                cid = next(next_id)
                await pw.send(json.dumps({"id": cid, "method": method, "params": params or {}, **({"sessionId": session} if session else {})}))
                return await until(lambda m: m.get("id") == cid)

            event = lambda name: until(lambda m: m.get("method") == name)  # noqa: E731

            self.assertEqual((await call("Browser.getVersion"))["result"]["product"], "Chrome/dt-browser")
            self.assertEqual((await call("Target.setAutoAttach", {"autoAttach": True, "flatten": True}))["result"], {})
            attached = (await event("Target.attachedToTarget"))["params"]
            self.assertEqual((attached["sessionId"], attached["targetInfo"]["targetId"]), ("dtb-tab-5", "T5"))
            self.assertIn(("cdp_attach", {"tabId": 5, "own": False}), self.fake.commands)

            # newPage: a reused relay tab is navigated to the requested URL before Playwright sees it.
            self.assertEqual((await call("Target.createTarget", {"url": "about:blank"}))["result"], {"targetId": "T7"})
            self.assertEqual((await event("Target.attachedToTarget"))["params"]["targetInfo"]["url"], "about:blank")
            self.assertIn(("cdp_send", {"tabId": 7, "method": "Page.navigate", "params": {"url": "about:blank"}}), self.fake.commands)

            reply = await call("Runtime.evaluate", {"expression": "1"}, "dtb-tab-7")
            self.assertEqual((reply["sessionId"], reply["result"]["echo"]["method"]), ("dtb-tab-7", "Runtime.evaluate"))
            self.assertIn("error", await call("Page.enable", {}, "dtb-tab-99"))

            # A flat child session (cross-origin frame) is routed back to its tab.
            await self.fake.event(7, "Target.attachedToTarget", {"sessionId": "C1", "targetInfo": {"type": "iframe"}})
            self.assertEqual((await event("Target.attachedToTarget"))["sessionId"], "dtb-tab-7")
            await self.fake.event(7, "Page.frameNavigated", {"frame": {}}, session="C1")
            self.assertEqual((await event("Page.frameNavigated"))["sessionId"], "C1")
            await call("Runtime.enable", {}, "C1")
            self.assertEqual(self.fake.commands[-1], ("cdp_send", {"tabId": 7, "sessionId": "C1", "method": "Runtime.enable", "params": {}}))

            # Browser-scoped commands go through an attached tab.
            await call("Storage.getCookies")
            self.assertEqual(self.fake.commands[-1][1]["method"], "Storage.getCookies")

            # A popup of tab 7 is attached as the client's own and announced with its opener.
            await self.fake.event(7, "dtb.tabOpened", {"tabId": 9})
            popup = (await event("Target.attachedToTarget"))["params"]
            self.assertEqual((popup["sessionId"], popup["targetInfo"]["openerId"]), ("dtb-tab-9", "T7"))
            self.assertIn(("cdp_attach", {"tabId": 9, "own": True}), self.fake.commands)
            await self.fake.event(9, "Inspector.detached", {"reason": "target_closed"})
            self.assertEqual((await event("Target.detachedFromTarget"))["params"]["sessionId"], "dtb-tab-9")

            # page.close(): the relay's own tab is closed, the user's tab only let go.
            self.assertEqual((await call("Target.closeTarget", {"targetId": "T7"}))["result"], {"success": True})
            self.assertEqual(self.fake.commands[-1], ("cdp_close", {"tabId": 7}))
            await call("Target.closeTarget", {"targetId": "T5"})
            self.assertEqual(self.fake.commands[-1], ("cdp_detach", {"tabId": 5}))
            self.assertIn("needs an attached tab", (await call("Storage.getCookies"))["error"]["message"])
        await asyncio.wait_for(self.fake.closed.wait(), 5)


    async def test_a_tab_closed_while_attaching_is_never_announced(self):
        async def close_tab_first(ws, cmd, p):
            if p.get("method") == "Target.getTargetInfo":
                await ws.send(json.dumps({"type": "event", "tabId": 5, "method": "Inspector.detached", "params": {"reason": "target_closed"}}))
        self.fake.before_reply = close_tab_first
        async with websockets.connect(f"ws://127.0.0.1:{self.port}/devtools/browser/x?tab=5", additional_headers=AUTH) as pw:
            await pw.send(json.dumps({"id": 1, "method": "Target.setAutoAttach", "params": {}}))
            reply = json.loads(await asyncio.wait_for(pw.recv(), 5))
            self.assertIn("closed while attaching", reply["error"]["message"])
            await pw.send(json.dumps({"id": 2, "method": "Storage.getCookies", "params": {}}))
            self.assertIn("needs an attached tab", json.loads(await asyncio.wait_for(pw.recv(), 5))["error"]["message"])


if __name__ == "__main__":
    unittest.main()

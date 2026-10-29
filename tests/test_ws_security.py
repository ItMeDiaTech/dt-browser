from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import bridge  # noqa: E402

TOKEN = "test-token"
EXTENSION_ORIGIN = "chrome-extension://" + "a" * 32


class WebSocketBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.controller = bridge.Controller(TOKEN)
        self.server_task = asyncio.create_task(bridge.ws_main(self.controller, self.port))
        for _ in range(100):
            try:
                async with websockets.connect(self.uri):
                    break
            except OSError:
                await asyncio.sleep(0.01)
        else:
            self.fail("WebSocket test server did not start")

    async def asyncTearDown(self):
        self.server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.server_task

    @property
    def uri(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def auth(self, ws, token=TOKEN, **fields):
        hello = json.loads(await asyncio.wait_for(ws.recv(), 1))
        self.assertEqual(hello["type"], "hello")
        nonce = "c" * 32
        await ws.send(json.dumps({"type": "auth", "proof": bridge.proof(token, "client", hello["nonce"]), "nonce": nonce, **fields}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), 1))
        if reply["type"] == "auth_ok":
            # The bridge proves it holds the token too, over the client's own nonce.
            self.assertEqual(reply["proof"], bridge.proof(TOKEN, "bridge", nonce))
        return reply

    async def test_http_origin_is_rejected_during_handshake(self):
        with self.assertRaises(InvalidStatus):
            async with websockets.connect(self.uri, origin="https://evil.example"):
                pass

    async def test_native_relay_without_origin_is_allowed(self):
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_ok")

    async def test_attach_conflict_does_not_reach_or_detach_the_extension(self):
        owner = object()
        self.assertTrue(self.controller.cdp_claim(7, owner))
        with patch.object(self.controller, "send_command", side_effect=RuntimeError("already attached")) as send:
            async with websockets.connect(self.uri) as relay:
                await self.auth(relay, client="relay")
                await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_attach", "params": {"tabId": 7}, "timeout": 1}))
                reply = json.loads(await asyncio.wait_for(relay.recv(), 2))
                self.assertFalse(reply["ok"])
                send.assert_not_called()
                self.assertIs(self.controller.cdp_owner(7), owner)

    async def test_inflight_attach_is_reserved_and_late_success_is_detached(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, \
                websockets.connect(self.uri) as first, websockets.connect(self.uri) as second:
            await self.auth(ext, extension="dt-browser", version=2)
            for relay in (first, second):
                await self.auth(relay, client="relay")
            request = {"type": "command", "id": 1, "cmd": "cdp_attach", "params": {"tabId": 7}, "timeout": 0.1}
            await first.send(json.dumps(request))
            attach = json.loads(await asyncio.wait_for(ext.recv(), 1))
            await second.send(json.dumps({**request, "timeout": 1}))
            refused = json.loads(await asyncio.wait_for(second.recv(), 1))
            self.assertFalse(refused["ok"])
            self.assertFalse(json.loads(await asyncio.wait_for(first.recv(), 1))["ok"])
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(ext.recv(), 0.1)
            await ext.send(json.dumps({"type": "response", "id": attach["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            detach = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual((detach["cmd"], detach["params"]), ("cdp_detach", {"tabId": 7}))
            await ext.send(json.dumps({"type": "response", "id": detach["id"], "ok": True, "result": {"detached": 7}}))
            for _ in range(50):
                if not self.controller._cdp_attaching:
                    break
                await asyncio.sleep(0.01)
            await second.send(json.dumps({**request, "id": 2, "timeout": 1}))
            retry = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual(retry["cmd"], "cdp_attach")
            await ext.send(json.dumps({"type": "response", "id": retry["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            self.assertTrue(json.loads(await asyncio.wait_for(second.recv(), 1))["ok"])
            await ext.close()

    async def test_timedout_attach_cleanup_is_bounded_by_extension_disconnect(self):
        with patch.object(bridge, "MAX_RELAY_TIMEOUT_SECONDS", 0.2):
            async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, websockets.connect(self.uri) as relay:
                await self.auth(ext, extension="dt-browser", version=2)
                await self.auth(relay, client="relay")
                await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_attach", "params": {"tabId": 7}, "timeout": 0.1}))
                self.assertEqual(json.loads(await asyncio.wait_for(ext.recv(), 1))["cmd"], "cdp_attach")
                self.assertFalse(json.loads(await asyncio.wait_for(relay.recv(), 1))["ok"])
                with self.assertRaises(ConnectionClosed):
                    await asyncio.wait_for(ext.recv(), 1)
                for _ in range(50):
                    if not self.controller._cdp_attaching and not self.controller._pending:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(self.controller._cdp_attaching, {})
                self.assertEqual(self.controller._pending, {})

    async def test_timedout_open_is_detached_after_its_late_response(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, websockets.connect(self.uri) as relay:
            await self.auth(ext, extension="dt-browser", version=2)
            await self.auth(relay, client="relay")
            await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_open", "params": {}, "timeout": 0.1}))
            opened = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertFalse(json.loads(await asyncio.wait_for(relay.recv(), 1))["ok"])
            await ext.send(json.dumps({"type": "response", "id": opened["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            detached = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual((detached["cmd"], detached["params"]), ("cdp_detach", {"tabId": 7}))
            await ext.send(json.dumps({"type": "response", "id": detached["id"], "ok": True, "result": {"detached": 7}}))

    async def test_extension_replacement_cancels_pending_attach_cleanup(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as old, websockets.connect(self.uri) as relay:
            await self.auth(old, extension="dt-browser", version=2)
            await self.auth(relay, client="relay")
            await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_attach", "params": {"tabId": 7}, "timeout": 0.1}))
            await old.recv()
            self.assertFalse(json.loads(await asyncio.wait_for(relay.recv(), 1))["ok"])
            async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as replacement:
                await self.auth(replacement, extension="dt-browser", version=2)
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(replacement.recv(), 0.1)
                self.assertEqual(self.controller._cdp_attaching, {})
                self.assertEqual(self.controller._pending, {})

    async def test_cli_loop_check_runs_locally_over_extension_primitives(self):
        with patch.object(self.controller, "send_command", return_value={"text": "ready"}) as send:
            async with websockets.connect(self.uri) as ws:
                self.assertEqual((await self.auth(ws, client="hermes-cli"))["type"], "auth_ok")
                await ws.send(json.dumps({"type": "command", "id": 1, "cmd": "loop_check", "params": {"expected": "ready"}, "timeout": 2}))
                reply = json.loads(await asyncio.wait_for(ws.recv(), 1))
                self.assertTrue(reply["ok"])
                self.assertTrue(reply["result"]["condition_met"])
                self.assertEqual(reply["result"]["attempts"], 1)
                self.assertEqual(send.call_args.args[0], "extract_text")

    async def test_extension_origin_and_identity_are_required_together(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ws:
            self.assertEqual(
                (await self.auth(ws, extension="dt-browser", version=2))["type"],
                "auth_ok",
            )
        async with websockets.connect(self.uri) as ws:
            self.assertEqual(
                (await self.auth(ws, extension="dt-browser", version=2))["type"],
                "auth_fail",
            )
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ws:
            self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_fail")

    async def test_unknown_and_repeated_roles_are_rejected(self):
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, client="unknown"))["type"], "auth_fail")
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_ok")
            await ws.send(json.dumps({"type": "auth", "token": TOKEN, "client": "relay"}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 1))["type"], "auth_fail")

    async def test_new_extension_connection_closes_displaced_owner(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as old_ws:
            self.assertEqual((await self.auth(old_ws, extension="dt-browser", version=2))["type"], "auth_ok")
            pending = asyncio.create_task(
                asyncio.to_thread(self.controller.send_command, "get_state", {}, 0.4)
            )
            command = json.loads(await asyncio.wait_for(old_ws.recv(), 1))
            self.assertEqual(command["type"], "command")
            async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as new_ws:
                self.assertEqual((await self.auth(new_ws, extension="dt-browser", version=2))["type"], "auth_ok")
                with self.assertRaises(ConnectionClosed):
                    await asyncio.wait_for(old_ws.recv(), 1)
                with self.assertRaisesRegex(RuntimeError, "replaced"):
                    await pending

    async def test_authentication_deadline_is_absolute(self):
        with patch.object(bridge, "WS_AUTH_TIMEOUT_SECONDS", 0.2):
            async with websockets.connect(self.uri) as ws:
                self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 1))["type"], "hello")

                async def send_malformed_frames():
                    while True:
                        await ws.send("{")
                        await asyncio.sleep(0.04)

                spam = asyncio.create_task(send_malformed_frames())
                try:
                    with self.assertRaises(ConnectionClosed):
                        await asyncio.wait_for(ws.recv(), 1)
                finally:
                    spam.cancel()
                    with contextlib.suppress(asyncio.CancelledError, ConnectionClosed):
                        await spam

    async def test_raw_cdp_tab_belongs_to_the_relay_that_opened_it(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext,                 websockets.connect(self.uri) as owner, websockets.connect(self.uri) as other:
            self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
            for ws in (owner, other):
                self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_ok")

            await owner.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_open", "params": {}, "timeout": 2}))
            command = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual(command["cmd"], "cdp_open")
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            self.assertEqual(json.loads(await asyncio.wait_for(owner.recv(), 1))["result"]["tabId"], 7)

            # The tab's events reach its owner only.
            event = {"type": "event", "tabId": 7, "method": "Page.frameStoppedLoading", "params": {"frameId": "T7"}}
            await ext.send(json.dumps(event))
            self.assertEqual(json.loads(await asyncio.wait_for(owner.recv(), 1)), event)

            # Another relay can neither drive nor close it; the refusal never reaches the extension.
            await other.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_send", "params": {"tabId": 7, "method": "Runtime.evaluate"}, "timeout": 2}))
            reply = json.loads(await asyncio.wait_for(other.recv(), 1))
            self.assertFalse(reply["ok"])
            self.assertIn("not attached by this client", reply["error"])
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(ext.recv(), 0.2)

            # An owner that disconnects has its tab detached.
            await owner.close()
            command = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual((command["cmd"], command["params"]), ("cdp_detach", {"tabId": 7}))
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"detached": 7}}))
            self.assertIsNone(self.controller.cdp_owner(7))

    async def test_pipelined_relay_commands_reach_the_extension_in_order(self):
        # Playwright sends a mouse press and its release without waiting: swapped, there is no click.
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, websockets.connect(self.uri) as relay:
            self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
            self.assertEqual((await self.auth(relay, client="relay"))["type"], "auth_ok")
            command = await self.open_cdp_tab(ext, relay)
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            await asyncio.wait_for(relay.recv(), 1)
            # Batches of the per-client slot count, answered only once all have arrived: sent from
            # worker threads, 7 in 10 such batches arrived out of order.
            for batch in range(5):
                ids = range(2 + batch * bridge.RELAY_SLOTS_PER_CLIENT, 2 + (batch + 1) * bridge.RELAY_SLOTS_PER_CLIENT)
                for i in ids:
                    await relay.send(json.dumps({"type": "command", "id": i, "cmd": "cdp_send", "params": {"tabId": 7, "method": f"M{i}"}, "timeout": 5}))
                commands = [json.loads(await asyncio.wait_for(ext.recv(), 2)) for _ in ids]
                self.assertEqual([c["params"]["method"] for c in commands], [f"M{i}" for i in ids])
                for command in commands:
                    await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {}}))
                for _ in ids:
                    await asyncio.wait_for(relay.recv(), 2)

    async def test_wrong_token_and_the_raw_token_are_refused(self):
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, token="wrong", client="relay"))["type"], "auth_fail")
        # The pre-v2 form (token in the clear, no nonce) is refused: the token never crosses the wire.
        async with websockets.connect(self.uri) as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "auth", "token": TOKEN, "client": "relay"}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 1))["type"], "auth_fail")

    async def test_no_auth_bridge_answers_with_an_empty_proof(self):
        self.controller.token = ""
        async with websockets.connect(self.uri) as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "auth", "proof": "", "nonce": "c" * 32, "client": "relay"}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 1)), {"type": "auth_ok", "proof": ""})

    async def test_relay_role_is_limited_to_raw_cdp_and_hermes_cli_is_not(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, \
                websockets.connect(self.uri) as relay, websockets.connect(self.uri) as cli:
            self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
            self.assertEqual((await self.auth(relay, client="relay"))["type"], "auth_ok")
            self.assertEqual((await self.auth(cli, client="hermes-cli"))["type"], "auth_ok")
            await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "eval", "params": {"js": "1"}, "timeout": 2}))
            reply = json.loads(await asyncio.wait_for(relay.recv(), 1))
            self.assertFalse(reply["ok"])
            self.assertIn("not available to a relay client", reply["error"])
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(ext.recv(), 0.2)
            await cli.send(json.dumps({"type": "command", "id": 1, "cmd": "eval", "params": {"js": "1"}, "timeout": 2}))
            command = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual(command["cmd"], "eval")

    async def test_non_object_frames_do_not_drop_the_connection(self):
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_ok")
            for frame in ("[]", '"x"', "3", "null"):
                await ws.send(frame)
            await ws.send(json.dumps({"type": "ping"}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 1))["type"], "pong")

    async def test_a_connected_relay_keeps_the_bridge_alive(self):
        self.assertFalse(self.controller.relay_active())
        async with websockets.connect(self.uri) as ws:
            self.assertEqual((await self.auth(ws, client="relay"))["type"], "auth_ok")
            self.assertTrue(self.controller.relay_active())
        for _ in range(50):
            if not self.controller.relay_active():
                break
            await asyncio.sleep(0.02)
        self.assertFalse(self.controller.relay_active())

    async def test_slow_relay_does_not_hold_up_extension_responses(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext, websockets.connect(self.uri) as relay:
            self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
            self.assertEqual((await self.auth(relay, client="relay"))["type"], "auth_ok")
            command = await self.open_cdp_tab(ext, relay)
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            await asyncio.wait_for(relay.recv(), 1)
            # The relay reads nothing while the extension floods events for its tab...
            for i in range(200):
                await ext.send(json.dumps({"type": "event", "tabId": 7, "method": "Network.dataReceived", "params": {"i": i}}))
            # ...and a Hermes command still gets its answer straight away.
            pending = asyncio.create_task(asyncio.to_thread(self.controller.send_command, "list_tabs", {}, 2))
            command = json.loads(await asyncio.wait_for(ext.recv(), 1))
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": []}))
            self.assertEqual(await asyncio.wait_for(pending, 1), [])

    async def open_cdp_tab(self, ext, relay):
        await relay.send(json.dumps({"type": "command", "id": 1, "cmd": "cdp_open", "params": {}, "timeout": 2}))
        return json.loads(await asyncio.wait_for(ext.recv(), 1))

    async def test_extension_disconnect_reports_its_raw_cdp_tabs_detached(self):
        async with websockets.connect(self.uri) as relay:
            self.assertEqual((await self.auth(relay, client="relay"))["type"], "auth_ok")
            async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext:
                self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
                command = await self.open_cdp_tab(ext, relay)
                await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
                self.assertTrue(json.loads(await asyncio.wait_for(relay.recv(), 1))["ok"])
            event = json.loads(await asyncio.wait_for(relay.recv(), 1))
            self.assertEqual((event["tabId"], event["method"]), (7, "Inspector.detached"))
            self.assertIsNone(self.controller.cdp_owner(7))

    async def test_tab_attached_after_its_relay_left_is_detached(self):
        async with websockets.connect(self.uri, origin=EXTENSION_ORIGIN) as ext:
            self.assertEqual((await self.auth(ext, extension="dt-browser", version=2))["type"], "auth_ok")
            relay = await websockets.connect(self.uri)
            self.assertEqual((await self.auth(relay, client="relay"))["type"], "auth_ok")
            command = await self.open_cdp_tab(ext, relay)
            await relay.close()
            await asyncio.sleep(0.1)
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"tabId": 7, "targetId": "T7"}}))
            command = json.loads(await asyncio.wait_for(ext.recv(), 1))
            self.assertEqual((command["cmd"], command["params"]), ("cdp_detach", {"tabId": 7}))
            await ext.send(json.dumps({"type": "response", "id": command["id"], "ok": True, "result": {"detached": 7}}))
            self.assertIsNone(self.controller.cdp_owner(7))


class BridgeHardeningTests(unittest.IsolatedAsyncioTestCase):
    def test_a_blocked_log_rollover_keeps_logging(self):
        # Windows refuses the rename while Get-Content -Wait holds the log open.
        import logging
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            handler = bridge.TolerantRotatingFileHandler(os.path.join(directory, "b.log"), maxBytes=50, backupCount=1, encoding="utf-8")
            record = logging.LogRecord("t", logging.INFO, __file__, 1, "x" * 40, None, None)
            try:
                with patch.object(handler, "rotate", side_effect=PermissionError("in use")), patch.object(handler, "handleError") as failed:
                    for _ in range(5):
                        handler.emit(record)
                    failed.assert_not_called()
                self.assertGreater(handler.retry_at, 0)
                self.assertGreater(os.path.getsize(os.path.join(directory, "b.log")), 150)
            finally:
                handler.close()

    def test_detached_tab_memory_is_capped(self):
        ctl = bridge.Controller(TOKEN)
        for tab in range(bridge.CDP_GONE_MAX + 50):
            ctl.cdp_release(tab)
        self.assertEqual(len(ctl._cdp_gone), bridge.CDP_GONE_MAX)
        self.assertNotIn(0, ctl._cdp_gone)

    def test_save_paths_stay_in_their_folder(self):
        for folder, ext in ((bridge.screenshot_dir(), ".png"), (bridge.export_dir(), ".html")):
            root = os.path.realpath(folder)
            self.assertEqual(os.path.dirname(bridge.confined_path("shot" + ext, folder, ext)), root)
            self.assertTrue(bridge.confined_path("shot", folder, ext).endswith("shot" + ext))
            for bad in ("../escape" + ext, os.path.join(os.path.expanduser("~"), "x" + ext), "C:/Windows/x" + ext, ".."):
                with self.assertRaises(ValueError):
                    bridge.confined_path(bad, folder, ext)

    async def call(self, app, headers):
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await app({"type": "http", "headers": headers}, receive, send)
        return sent

    async def test_mcp_http_needs_the_bearer_token(self):
        async def inner(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})

        app = bridge.bearer_auth(inner, TOKEN)
        self.assertEqual((await self.call(app, []))[0]["status"], 401)
        self.assertEqual((await self.call(app, [(b"authorization", b"Bearer wrong")]))[0]["status"], 401)
        self.assertEqual((await self.call(app, [(b"authorization", f"Bearer {TOKEN}".encode())]))[0]["status"], 200)
        self.assertIs(bridge.bearer_auth(inner, ""), inner)

    def test_no_auth_needs_an_explicit_confirmation(self):
        env = {k: v for k, v in os.environ.items() if k != "DT_BRIDGE_ALLOW_NO_AUTH"}
        with patch.object(sys, "argv", ["bridge.py", "--no-auth"]), patch.dict(os.environ, env, clear=True), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                bridge.main()


if __name__ == "__main__":
    unittest.main()

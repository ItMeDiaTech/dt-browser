from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import bridge  # noqa: E402

COMPACT_TOOLS = {"browser_health", "browser_read", "browser_do", "browser_help"}


class FakeController:
    def __init__(self, connected: bool = True) -> None:
        self.connected = connected
        self.commands: list[tuple[str, dict, float]] = []

    def get_ws(self):
        return object() if self.connected else None

    def get_extension_info(self):
        return {"extension": "dt-browser", "version": 1}

    def send_command(self, command: str, params: dict | None = None, timeout: float = 30.0):
        normalized = params or {}
        self.commands.append((command, normalized, timeout))
        if command == "list_tabs":
            return [
                {"id": 7, "windowId": 1, "active": True, "title": "Active", "url": "https://active.test"},
                {"id": 8, "windowId": 1, "active": False, "title": "Other", "url": "https://other.test"},
            ]
        if command == "screenshot":
            return {"tabId": 7, "mime": "image/png", "dataUrl": "data:image/png;base64," + base64.b64encode(b"png-bytes").decode()}
        return {"command": command, "params": normalized}


def tool_names(mcp) -> set[str]:
    return set(mcp._tool_manager._tools)


def schema_chars(mcp) -> int:
    tools = asyncio.run(mcp.list_tools())
    return sum(len(json.dumps(tool.model_dump(mode="json"), separators=(",", ":"))) for tool in tools)


class CompactSurfaceTests(unittest.TestCase):
    def test_compact_profile_exposes_four_high_value_tools(self):
        self.assertEqual(tool_names(bridge.build_mcp(FakeController())), COMPACT_TOOLS)

    def test_compact_schema_stays_small(self):
        compact = schema_chars(bridge.build_mcp(FakeController()))
        self.assertLess(compact, 6000, compact)


class ControllerConcurrencyTests(unittest.TestCase):
    def test_registered_command_fails_when_socket_is_replaced(self):
        controller = bridge.Controller("")
        old_socket = object()
        old_loop = object()
        controller.replace_ws(old_socket, old_loop)
        ws, loop, _, future = controller._register_command()
        self.assertIs(ws, old_socket)
        self.assertIs(loop, old_loop)

        controller.replace_ws(object(), object())

        with self.assertRaisesRegex(RuntimeError, "replaced"):
            future.result()


class CompactToolTests(unittest.TestCase):
    def setUp(self):
        self.controller = FakeController()
        self.mcp = bridge.build_mcp(self.controller)

    def call(self, name: str, *args, **kwargs):
        return self.mcp._tool_manager._tools[name].fn(*args, **kwargs)

    def test_health_omits_tab_inventory_but_reports_active_tab(self):
        result = self.call("browser_health")
        self.assertTrue(result["extension_connected"])
        self.assertEqual(result["tab_count"], 2)
        self.assertEqual(result["active_tab"]["id"], 7)
        self.assertNotIn("tabs", result)

    def test_do_normalizes_snake_case_parameters(self):
        result = self.call("browser_do", "navigate", {"url": "https://example.test", "tab_id": 42})
        self.assertEqual(result["command"], "navigate")
        self.assertEqual(
            self.controller.commands[-1],
            ("navigate", {"url": "https://example.test", "tabId": 42}, 60.0),
        )

    def test_do_derives_wait_timeout_and_requires_target(self):
        self.call("browser_do", "wait_for", {"target": "#ready", "timeout_ms": 2500})
        self.assertEqual(
            self.controller.commands[-1],
            ("wait_for", {"target": "#ready", "timeoutMs": 2500}, 17.5),
        )
        with self.assertRaisesRegex(ValueError, "target"):
            self.call("browser_do", "wait_for", {})

    def test_do_rejects_unknown_command(self):
        with self.assertRaisesRegex(ValueError, "unknown browser command"):
            self.call("browser_do", "delete_everything", {})

    def test_do_wraps_tab_list_for_one_mcp_content_result(self):
        result = self.call("browser_do", "list_tabs", {})
        self.assertEqual(len(result["tabs"]), 2)
        self.assertEqual(result["tabs"][0]["id"], 7)

    # save_path is a file name inside the screenshot folder (any other path is refused, see
    # test_ws_security); the folder is redirected to a temporary one here.
    def test_do_screenshot_saves_and_omits_base64_by_default(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "screenshot_dir", lambda: directory):
            path = str(Path(directory).resolve() / "shot.png")
            result = self.call("browser_do", "screenshot", {"save_path": "shot.png"})
            self.assertEqual(Path(path).read_bytes(), b"png-bytes")
            self.assertEqual(result["saved_to"], path)
            self.assertNotIn("dataUrl", result)
            self.assertTrue(result["data_url_omitted"])

    def test_do_screenshot_keeps_base64_only_when_requested(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "screenshot_dir", lambda: directory):
            result = self.call(
                "browser_do",
                "screenshot",
                {"save_path": "shot.png", "include_data_url": True},
            )
            self.assertTrue(result["dataUrl"].startswith("data:image/png"))

    def test_read_sends_bounded_compact_request(self):
        self.call(
            "browser_read",
            mode="page",
            query="Sign in",
            selector="main",
            max_chars=100,
            max_elements=4,
            offset=2,
            viewport_only=True,
            include_geometry=True,
            tab_id=9,
        )
        self.assertEqual(
            self.controller.commands[-1],
            (
                "read",
                {
                    "mode": "page",
                    "query": "Sign in",
                    "selector": "main",
                    "maxChars": 100,
                    "maxElements": 4,
                    "offset": 2,
                    "viewportOnly": True,
                    "includeGeometry": True,
                    "tabId": 9,
                },
                20.0,
            ),
        )

    def test_read_rejects_invalid_mode_and_negative_limits(self):
        with self.assertRaisesRegex(ValueError, "mode"):
            self.call("browser_read", mode="everything")
        with self.assertRaisesRegex(ValueError, "max_chars"):
            self.call("browser_read", max_chars=-1)

    def test_read_screenshot_mode_saves_and_returns_path_and_hint(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "screenshot_dir", lambda: directory):
            result = self.call("browser_read", mode="screenshot")
            self.assertTrue(result["ok"])
            self.assertEqual(result["mode"], "screenshot")
            self.assertTrue(result["saved_to"].endswith(".png"))
            self.assertIn("vision_analyze", result["hint"])

    def test_read_screenshot_reports_disk_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "screenshot_dir", lambda: directory):
            with patch("builtins.open", side_effect=PermissionError("disk denied")):
                result = self.call("browser_read", mode="screenshot")
        self.assertFalse(result["ok"])
        self.assertIsNone(result["saved_to"])
        self.assertIn("disk denied", result["save_error"])
        self.assertNotIn("Image saved", result.get("hint", ""))

    def test_element_gone_does_not_hide_command_failure(self):
        with patch.object(self.controller, "send_command", side_effect=RuntimeError("extension disconnected")):
            with self.assertRaisesRegex(RuntimeError, "disconnected"):
                bridge.execute_loop_check(self.controller, {"condition": "element_gone", "target": "#busy"}, 0.1)

    def test_element_gone_accepts_a_missing_element(self):
        with patch.object(self.controller, "send_command", return_value={"ok": False, "error": "no element matches selector: #busy"}):
            result = bridge.execute_loop_check(self.controller, {"condition": "element_gone", "target": "#busy"}, 0.1)
        self.assertTrue(result["condition_met"])

    def test_loop_check_preserves_explicit_zero_tab_id(self):
        with patch.object(self.controller, "send_command", return_value={"ok": True, "visible": False}) as send:
            result = bridge.execute_loop_check(self.controller, {"condition": "element_gone", "target": "#busy", "tabId": 0}, 0.1)
        self.assertTrue(result["condition_met"])
        self.assertEqual(send.call_args.args[1]["tabId"], 0)

    def test_element_gone_does_not_accept_an_invalid_selector(self):
        with patch.object(self.controller, "send_command", return_value={"ok": False, "error": "bad CSS selector"}):
            with self.assertRaisesRegex(RuntimeError, "bad CSS selector"):
                bridge.execute_loop_check(self.controller, {"condition": "element_gone", "target": "["}, 0.1)

    def test_read_elements_and_html_modes(self):
        self.call("browser_read", mode="elements", selector="form", max_elements=25)
        self.assertEqual(self.controller.commands[-1][0], "read")
        self.assertEqual(self.controller.commands[-1][1]["mode"], "elements")
        self.assertEqual(self.controller.commands[-1][1]["selector"], "form")
        self.assertEqual(self.controller.commands[-1][1]["maxElements"], 25)

        self.call("browser_read", mode="html", selector="#main", max_chars=1200)
        self.assertEqual(self.controller.commands[-1][0], "read")
        self.assertEqual(self.controller.commands[-1][1]["mode"], "html")
        self.assertEqual(self.controller.commands[-1][1]["selector"], "#main")
        self.assertEqual(self.controller.commands[-1][1]["maxChars"], 1200)

    def test_loop_check_stops_when_condition_met(self):
        def fake_extract(*args, **kwargs):
            return {"text": "Job Finished Successfully"}
        with patch.object(self.controller, "send_command", side_effect=fake_extract):
            result = bridge.execute_loop_check(
                self.controller,
                {"condition": "text_contains", "expected": "Finished", "intervalS": 0.01, "timeout": 2.0},
            )
            self.assertTrue(result["ok"])
            self.assertTrue(result["condition_met"])
            self.assertEqual(result["attempts"], 1)

    def test_loop_check_timeout_cannot_exceed_the_callers_limit(self):
        with patch.object(self.controller, "send_command", return_value={"text": ""}):
            result = bridge.execute_loop_check(
                self.controller, {"condition": "text_contains", "expected": "never", "intervalS": 0.1, "timeout": 100000}, 0.3)
        self.assertFalse(result["ok"])
        self.assertLess(result["elapsed_s"], 2)
        self.assertIn("0.3s", result["error"])

    def test_export_html_save_path_stays_in_the_export_folder(self):
        for bad in ("../../escape.html", os.path.join(os.path.expanduser("~"), "x.html")):
            with self.assertRaisesRegex(ValueError, "inside"):
                self.call("browser_do", "export_html", {"save_path": bad})
        self.assertEqual(self.controller.commands, [], "nothing was sent for a refused path")

    def test_tab_naming_and_selection_commands(self):
        self.call("browser_do", "name_tab", {"name": "worker_1", "tab_id": 7})
        self.assertEqual(self.controller.commands[-1], ("name_tab", {"name": "worker_1", "tabId": 7}, 20.0))

        self.call("browser_do", "switch_tab", {"target": "worker_1"})
        self.assertEqual(self.controller.commands[-1], ("switch_tab", {"target": "worker_1"}, 20.0))

        self.call("browser_do", "create_tab", {"url": "https://example.test", "name": "worker_2"})
        self.assertEqual(self.controller.commands[-1], ("create_tab", {"url": "https://example.test", "name": "worker_2"}, 20.0))

        self.call("browser_do", "get_element_state", {"target": "#checkbox"})
        self.assertEqual(self.controller.commands[-1], ("get_element_state", {"target": "#checkbox"}, 20.0))

    def test_help_is_concise_and_command_specific(self):
        index = self.call("browser_help")
        self.assertIn("navigate", index["commands"])
        detail = self.call("browser_help", "type")
        self.assertEqual(detail["command"], "type")
        self.assertIn("target", detail["params"])
        with self.assertRaisesRegex(ValueError, "unknown browser command"):
            self.call("browser_help", "missing")


class StartupTests(unittest.TestCase):
    def test_websocket_thread_reports_bind_failure(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with patch("threading.excepthook"), self.assertRaises(OSError):
                bridge.run_ws_thread(bridge.Controller("test-token"), occupied.getsockname()[1])

    def test_stdio_does_not_start_mcp_after_websocket_startup_failure(self):
        mcp = Mock()
        with patch.object(sys, "argv", ["bridge.py", "--stdio"]), patch.object(bridge, "_resolve_token", return_value="test-token"), \
                patch.object(bridge, "build_mcp", return_value=mcp), patch.object(bridge, "run_ws_thread", side_effect=OSError("port busy")), \
                patch.object(bridge.logging, "basicConfig"):
            self.assertEqual(bridge.main(), 1)
        mcp.run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

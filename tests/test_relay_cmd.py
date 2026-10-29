from __future__ import annotations

import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import relay_cmd  # noqa: E402


class RelayTokenTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows launcher")
    def test_foreground_launcher_preserves_environment_token(self):
        with tempfile.TemporaryDirectory() as directory:
            copied = Path(directory) / "bridge"
            copied.mkdir()
            (copied / "start_bridge.cmd").write_bytes((ROOT / "bridge" / "start_bridge.cmd").read_bytes())
            (copied / "token.txt").write_text("file-token\n", encoding="utf-8")
            (copied / "uv.cmd").write_text("@echo off\n@echo %DT_BRIDGE_TOKEN%\n", encoding="utf-8")
            # The fake uv must win by PATH: cmd skips the current folder when
            # NoDefaultCurrentDirectoryInExePath is set.
            env = dict(os.environ, DT_BRIDGE_TOKEN="env-token", PATH=f"{copied}{os.pathsep}{os.environ.get('PATH', '')}")
            result = subprocess.run(["cmd", "/d", "/c", str(copied / "start_bridge.cmd")], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "env-token")

    def test_environment_token_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.txt"
            token_file.write_text("file-token\n", encoding="utf-8")
            self.assertEqual(
                relay_cmd.resolve_token(token_file, {"DT_BRIDGE_TOKEN": "env-token"}),
                "env-token",
            )

    def test_token_file_is_the_default_credential_source(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.txt"
            token_file.write_text("file-token\n", encoding="utf-8")
            self.assertEqual(relay_cmd.resolve_token(token_file, {}), "file-token")

    def test_missing_token_requires_explicit_no_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.txt"
            with self.assertRaisesRegex(RuntimeError, "token"):
                relay_cmd.resolve_token(missing, {})
            self.assertEqual(relay_cmd.resolve_token(missing, {}, allow_empty=True), "")

    def test_script_headers_share_environment_file_and_missing_token_behavior(self):
        for script in ("scripts/e2e_compact_test.py", "jev-harness/bench/token_bench.py"):
            with self.subTest(script=script), patch.object(sys, "path", sys.path.copy()), patch.dict(sys.modules, {"tiktoken": Mock()}):
                # Token counting is unrelated to header resolution; no tokenizer or network is needed.
                headers = runpy.run_path(str(ROOT / script))["bridge_headers"]
                with patch.dict(os.environ, {"DT_BRIDGE_TOKEN": " env-token "}), patch.object(Path, "read_text") as read:
                    self.assertEqual(headers(), {"Authorization": "Bearer env-token"})
                    read.assert_not_called()
                with patch.dict(os.environ, {"DT_BRIDGE_TOKEN": " "}), patch.object(Path, "read_text", return_value="file-token\n"):
                    self.assertEqual(headers(), {"Authorization": "Bearer file-token"})
                with patch.dict(os.environ, {"DT_BRIDGE_TOKEN": ""}), patch.object(Path, "read_text", side_effect=OSError("missing")):
                    self.assertEqual(headers(), {})


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import hermes_proc


class HermesProcessTests(unittest.TestCase):
    def test_failed_enumeration_keeps_the_bridge_alive(self):
        failed = subprocess.CompletedProcess([], 1, "", "access denied")
        with patch.object(hermes_proc.sys, "platform", "win32"), patch.object(hermes_proc.subprocess, "run", return_value=failed):
            self.assertTrue(hermes_proc.any_hermes_instance())

    def test_windows_process_detection_and_fail_safe(self):
        with patch.object(hermes_proc.sys, "platform", "win32"):
            for output, expected in [('"hermes.exe","123"', True), ('"python.exe","456"', False)]:
                with self.subTest(output=output), patch.object(hermes_proc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
                    self.assertEqual(hermes_proc.any_hermes_instance(), expected)
            with patch.object(hermes_proc.subprocess, "run", side_effect=OSError("unavailable")):
                self.assertTrue(hermes_proc.any_hermes_instance())

    def test_other_platforms_keep_bridge_alive_without_enumerating(self):
        with patch.object(hermes_proc.sys, "platform", "linux"), patch.object(hermes_proc.subprocess, "run") as run:
            self.assertTrue(hermes_proc.any_hermes_instance())
            run.assert_not_called()

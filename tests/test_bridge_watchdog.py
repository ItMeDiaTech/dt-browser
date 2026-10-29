from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import bridge_watchdog as wd


class BridgeWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [patch.object(wd, "LOG", self.tmp / "w.log"),
                        patch.object(wd, "STAMP", self.tmp / "stamp"),
                        patch.object(wd, "PYTHONW", Path(sys.executable)),
                        patch.object(wd.time, "sleep")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_clean_env_drops_leaked_python_paths(self):
        env = wd.clean_env({"PYTHONPATH": "x", "pythonhome": "y", "VIRTUAL_ENV": "z", "PATH": "p"})
        self.assertEqual(env, {"PATH": "p"})

    def test_healthy_bridge_is_left_alone(self):
        with patch.object(wd, "port_up", return_value=True), patch.object(wd, "launch") as launch:
            self.assertEqual(wd.main(), 0)
        launch.assert_not_called()
        self.assertFalse(wd.LOG.exists(), "a healthy tick must write nothing")

    def test_recent_launch_is_given_time_to_bind(self):
        wd.STAMP.write_text(str(wd.time.time()), encoding="utf-8")
        with patch.object(wd, "port_up", return_value=False), patch.object(wd, "launch") as launch:
            self.assertEqual(wd.main(), 0)
        launch.assert_not_called()

    def test_broken_environment_is_logged_not_launched(self):
        with patch.object(wd, "port_up", return_value=False), \
             patch.object(wd, "preflight", return_value="ModuleNotFoundError: pydantic_core"), \
             patch.object(wd, "launch") as launch:
            self.assertEqual(wd.main(), 1)
        launch.assert_not_called()
        self.assertIn("imports fail", wd.LOG.read_text(encoding="utf-8"))

    def test_launch_gets_a_clean_env_and_is_confirmed_by_the_port(self):
        ports = iter([False, False, True])
        proc = Mock(pid=42, poll=Mock(return_value=None))
        with patch.dict(wd.os.environ, {"PYTHONPATH": "C:/hermes/venv"}), \
             patch.object(wd, "port_up", side_effect=lambda *_: next(ports)), \
             patch.object(wd, "preflight", return_value=None), \
             patch.object(wd, "launch", return_value=proc) as launch:
            self.assertEqual(wd.main(), 0)
        self.assertNotIn("PYTHONPATH", launch.call_args.args[0])
        self.assertIn("started pid 42", wd.LOG.read_text(encoding="utf-8"))

    def test_a_launch_that_dies_is_reported(self):
        proc = Mock(pid=7, poll=Mock(return_value=1), returncode=1)
        with patch.object(wd, "port_up", return_value=False), \
             patch.object(wd, "preflight", return_value=None), \
             patch.object(wd, "launch", return_value=proc):
            self.assertEqual(wd.main(), 1)
        self.assertIn("exited with code 1", wd.LOG.read_text(encoding="utf-8"))

    def test_rotation_keeps_a_bounded_set(self):
        log = self.tmp / "r.log"
        for i in range(5):
            log.write_text("x" * 10 + str(i), encoding="utf-8")
            wd.rotate(log, max_bytes=5, keep=2)
        self.assertEqual(sorted(p.name for p in self.tmp.glob("r.log*")), ["r.log.1", "r.log.2"])
        self.assertEqual((self.tmp / "r.log.1").read_text(encoding="utf-8"), "xxxxxxxxxx4")


if __name__ == "__main__":
    unittest.main()

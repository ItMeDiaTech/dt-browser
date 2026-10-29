import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch


spec = importlib.util.spec_from_file_location("workflow_runner", Path(__file__).resolve().parents[1] / "scripts/browser_workflow_e2e.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class CleanupTests(unittest.TestCase):
    def temporary(self):
        return Mock(name=str(Path(tempfile.gettempdir()) / "dt-browser-workflow-test"))

    def test_retries_transient_windows_handles(self):
        temporary = self.temporary()
        temporary.name = str(Path(tempfile.gettempdir()) / "dt-browser-workflow-test")
        temporary.cleanup.side_effect = [PermissionError("locked"), PermissionError("locked"), None]
        with patch.object(runner.asyncio, "sleep", new_callable=AsyncMock):
            asyncio.run(runner.cleanup_temporary(temporary))
        self.assertEqual(temporary.cleanup.call_count, 3)

    def test_persistent_failure_is_not_suppressed(self):
        temporary = self.temporary()
        temporary.name = str(Path(tempfile.gettempdir()) / "dt-browser-workflow-test")
        temporary.cleanup.side_effect = PermissionError("locked")
        with patch.object(runner.asyncio, "sleep", new_callable=AsyncMock):
            with self.assertRaises(PermissionError):
                asyncio.run(runner.cleanup_temporary(temporary))
        self.assertEqual(temporary.cleanup.call_count, 20)

    def test_unexpected_path_is_never_cleaned(self):
        temporary = self.temporary()
        temporary.name = str(Path(tempfile.gettempdir()).parent / "dt-browser-workflow-test")
        with self.assertRaises(ValueError):
            asyncio.run(runner.cleanup_temporary(temporary))
        temporary.cleanup.assert_not_called()

from __future__ import annotations

import asyncio
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cdp


class WorkerProbeTests(unittest.TestCase):
    def probe(self, evaluation):
        calls = []

        class Session:
            async def cmd(self, method, params=None, session=None):
                calls.append((method, params, session))
                if method == "Target.getTargets":
                    return {"result": {"targetInfos": [{"type": "service_worker", "url": "fixture/background.js", "targetId": "worker"}]}}
                if method == "Target.attachToTarget":
                    return {"result": {"sessionId": "worker-session"}}
                return evaluation

        async def browser(fn):
            return await fn(Session())

        with patch.object(cdp, "with_browser", browser), contextlib.redirect_stdout(io.StringIO()):
            status = asyncio.run(cdp.sw_probe("1+1", 0))
        return status, calls[-1]

    def test_worker_evaluation_uses_attached_session(self):
        status, (_, params, session) = self.probe({"result": {"result": {"value": 2}}})
        self.assertEqual(status, 0)
        self.assertEqual(session, "worker-session")
        self.assertNotIn("contextId", params)

    def test_worker_protocol_and_javascript_errors_fail(self):
        for response in ({"error": {"message": "wrong session"}}, {"result": {"exceptionDetails": {"text": "failure"}}}):
            with self.subTest(response=response):
                status, _ = self.probe(response)
                self.assertEqual(status, 1)


if __name__ == "__main__":
    unittest.main()

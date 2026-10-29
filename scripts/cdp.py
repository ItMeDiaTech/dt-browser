#!/usr/bin/env python3
"""CDP helpers for the Chrome for Testing instance used by the E2E (see README).

Usage:
  python scripts/cdp.py eval "<js>"     # evaluate in the test page (URL contains 8900)
  python scripts/cdp.py open <url>      # navigate the first page target
  python scripts/cdp.py sw [--eval JS] [--wait N]  # attach to the extension service worker
"""
import argparse
import asyncio
import json
import sys
import urllib.request

import websockets

CDP_HTTP = "http://127.0.0.1:9223"
EXT_FRAG = "background.js"


def get_json(path):
    with urllib.request.urlopen(CDP_HTTP + path, timeout=5) as r:
        return json.load(r)


class Session:
    def __init__(self, ws):
        self.ws = ws
        self.mid = 0

    async def cmd(self, method, params=None, session=None):
        self.mid += 1
        payload = {"id": self.mid, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        await self.ws.send(json.dumps(payload))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.mid:
                return msg


async def with_browser(fn):
    version = get_json("/json/version")
    async with websockets.connect(version["webSocketDebuggerUrl"], max_size=2**26) as ws:
        return await fn(Session(ws))


async def page_target(s, needle):
    res = await s.cmd("Target.getTargets")
    return next((t for t in res["result"]["targetInfos"] if t.get("type") == "page" and needle in t.get("url", "")), None)


async def eval_page(expr):
    async def run(s):
        page = await page_target(s, "8900")
        if not page:
            print("test page target not found")
            return 1
        attach = await s.cmd("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
        sid = attach["result"]["sessionId"]
        res = await s.cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, session=sid)
        print(json.dumps(res.get("result", res.get("error")), indent=1)[:2500])
        return 0

    return await with_browser(run)


async def open_page(url):
    async def run(s):
        page = await page_target(s, "")
        if not page:
            print("no page target")
            return 1
        attach = await s.cmd("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
        sid = attach.get("result", {}).get("sessionId")
        if not sid:
            return 1
        res = await s.cmd("Page.navigate", {"url": url}, session=sid)
        print("navigated:", json.dumps(res.get("result", res.get("error")))[:200])
        return 0

    return await with_browser(run)


async def sw_probe(expr, wait):
    async def run(s):
        res = await s.cmd("Target.getTargets")
        targets = res.get("result", {}).get("targetInfos", [])
        sw = next((t for t in targets if t.get("type") == "service_worker" and EXT_FRAG in t.get("url", "")), None)
        if not sw:
            print("SW target not found. targets:", [(t.get("type"), t.get("url", "")[:60]) for t in targets])
            return 1
        print("SW:", sw["url"])
        attach = await s.cmd("Target.attachToTarget", {"targetId": sw["targetId"], "flatten": True})
        sid = attach["result"]["sessionId"]
        if wait:
            await asyncio.sleep(wait)
        if expr:
            res = await s.cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, session=sid)
            print(json.dumps(res, indent=1)[:4000])
            if "error" in res or res.get("result", {}).get("exceptionDetails"):
                return 1
        else:
            print("attached, session", sid)
        return 0

    return await with_browser(run)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("eval"); p.add_argument("js")
    p = sub.add_parser("open"); p.add_argument("url")
    p = sub.add_parser("sw"); p.add_argument("--eval", dest="js"); p.add_argument("--wait", type=int, default=0)
    args = ap.parse_args()
    if args.cmd == "eval":
        return asyncio.run(eval_page(args.js))
    if args.cmd == "open":
        return asyncio.run(open_page(args.url))
    return asyncio.run(sw_probe(args.js, args.wait))


if __name__ == "__main__":
    sys.exit(main())

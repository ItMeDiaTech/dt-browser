#!/usr/bin/env python3
"""Drive dt-browser through the authenticated relay-client channel.

Usage: python relay_cmd.py COMMAND [JSON_PARAMS] [TIMEOUT]
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Mapping

import websockets

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
DEFAULT_WS = "ws://127.0.0.1:18765"
DEFAULT_TOKEN_FILE = HERE / "token.txt"


def resolve_token(
    token_file: Path = DEFAULT_TOKEN_FILE,
    environ: Mapping[str, str] | None = None,
    *,
    allow_empty: bool = False,
) -> str:
    env = os.environ if environ is None else environ
    token = str(env.get("DT_BRIDGE_TOKEN", "")).strip()
    if token:
        return token
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if token or allow_empty:
        return token
    raise RuntimeError(
        f"bridge token not found; set DT_BRIDGE_TOKEN or create {token_file} "
        "(use --no-auth only with a development bridge started --no-auth)"
    )


def proof(token: str, label: str, nonce: str) -> str:
    """The bridge's HMAC-SHA256(token, "<label>:<nonce>"); the token itself never goes on the wire.
    Empty with no token (a --no-auth bridge)."""
    if not token:
        return ""
    return hmac.new(token.encode("utf-8"), f"{label}:{nonce}".encode("utf-8"), "sha256").hexdigest()


async def authenticate(ws, token: str, client: str) -> None:
    """Answer the bridge's nonce, then check its answer to ours: a process squatting on the port
    can neither learn the token nor pass as the bridge."""
    hello = json.loads(await asyncio.wait_for(ws.recv(), 10))
    if not isinstance(hello, dict) or hello.get("type") != "hello" or not isinstance(hello.get("nonce"), str):
        raise RuntimeError("the bridge did not send a hello (an older bridge, or not the bridge)")
    mine = secrets.token_hex(16)
    await ws.send(json.dumps({"type": "auth", "proof": proof(token, "client", hello["nonce"]), "nonce": mine, "client": client}))
    ack = json.loads(await asyncio.wait_for(ws.recv(), 10))
    if not isinstance(ack, dict) or ack.get("type") != "auth_ok":
        raise RuntimeError(f"authentication failed: {ack.get('reason') if isinstance(ack, dict) else ack}")
    if not hmac.compare_digest(str(ack.get("proof", "")), proof(token, "bridge", mine)):
        raise RuntimeError("the server on this port could not prove it holds the bridge token")


async def relay_command(
    command: str,
    params: dict,
    timeout: float,
    token: str,
    ws_url: str,
) -> int:
    async with websockets.connect(ws_url, max_size=2**26) as ws:
        # hermes-cli: the MCP tools' full command set (a "relay" client is limited to raw CDP).
        await authenticate(ws, token, "hermes-cli")
        await ws.send(json.dumps({
            "type": "command",
            "id": 1,
            "cmd": command,
            "params": params,
            "timeout": timeout,
        }))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout + 15))
            if msg.get("type") == "response" and msg.get("id") == 1:
                print(json.dumps(msg))
                return 0 if msg.get("ok") else 2


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command")
    parser.add_argument("params", nargs="?", default="{}", help="JSON object (default: {})")
    parser.add_argument("timeout", nargs="?", type=float, default=120.0)
    parser.add_argument("--ws-url", default=os.environ.get("DT_BRIDGE_WS_URL", DEFAULT_WS))
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_FILE)
    parser.add_argument("--no-auth", action="store_true", help="allow an empty token for a bridge started with --no-auth")
    args = parser.parse_args(argv)
    try:
        args.params = json.loads(args.params)
    except json.JSONDecodeError as exc:
        parser.error(f"params must be valid JSON: {exc}")
    if not isinstance(args.params, dict):
        parser.error("params must decode to a JSON object")
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        token = resolve_token(args.token_file, allow_empty=args.no_auth)
        return asyncio.run(relay_command(args.command, args.params, args.timeout, token, args.ws_url))
    except (OSError, RuntimeError, TimeoutError, websockets.WebSocketException) as exc:
        print(f"relay failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

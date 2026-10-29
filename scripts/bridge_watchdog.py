"""Keep the dt-browser bridge up, without Hermes.

The Windows task "dt-browser bridge watchdog" runs this every minute under the bridge's own
pythonw. When nothing listens on the extension port it starts `bridge.py --no-lifecycle`, so
the bridge stays up whether or not a Hermes window is open. Healthy ticks write nothing.

Two failures it guards against, both seen 2026-10-24 with the old Hermes cron watchdog:
  * an inherited PYTHONPATH pointed the bridge's 3.13 interpreter at a 3.14 venv, and every
    relaunch died importing pydantic_core; the child now gets a clean environment, and a
    broken environment is logged by an import preflight instead of crash-looping;
  * a launch that dies silently looked like a launch; the tick now waits for the port.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "bridge"
PYTHONW = BRIDGE_DIR / ".venv" / "Scripts" / "pythonw.exe"
WS_PORT = int(os.environ.get("DT_BRIDGE_WS_PORT", "18765"))
LOG = BRIDGE_DIR / "bridge.watchdog.log"
STAMP = BRIDGE_DIR / ".watchdog_last_launch"
START_GRACE = 90      # seconds: a bridge launched this recently may still be binding its ports
START_WAIT = 20       # seconds this tick waits for a fresh bridge to listen
LOG_MAX_BYTES, LOG_KEEP = 1_000_000, 3
# Python paths a parent (a cron gateway, an activated venv shell) can leak into the child.
LEAKY_ENV = ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")
PREFLIGHT = "import mcp.server.fastmcp, websockets"  # the imports that crashed relaunches

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000  # outlive the scheduled task's job object


def port_up(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex((host, port)) == 0


def clean_env(environ: dict) -> dict:
    """The environment minus inherited Python paths; the bridge needs only its own venv."""
    return {k: v for k, v in environ.items() if k.upper() not in LEAKY_ENV}


def rotate(path: Path, max_bytes: int = LOG_MAX_BYTES, keep: int = LOG_KEEP) -> None:
    """Shift path -> path.1 -> ... -> path.<keep> once path reaches max_bytes."""
    try:
        if path.stat().st_size < max_bytes:
            return
    except FileNotFoundError:
        return
    for i in range(keep - 1, 0, -1):
        older = path.with_name(f"{path.name}.{i}")
        if older.exists():
            os.replace(older, path.with_name(f"{path.name}.{i + 1}"))
    os.replace(path, path.with_name(f"{path.name}.1"))


def note(msg: str) -> None:
    rotate(LOG)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def launched_recently(now: float) -> bool:
    try:
        return now - float(STAMP.read_text(encoding="utf-8").strip()) < START_GRACE
    except (OSError, ValueError):
        return False


def preflight(env: dict) -> str | None:
    """None when the bridge's imports load in the clean environment, else the error tail."""
    try:
        out = subprocess.run([str(PYTHONW), "-c", PREFLIGHT], cwd=str(BRIDGE_DIR), env=env,
                             capture_output=True, text=True, timeout=60,
                             creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"preflight could not run: {exc}"
    if out.returncode:
        return (out.stderr or out.stdout or f"exit {out.returncode}").strip().splitlines()[-1]
    return None


def launch(env: dict) -> subprocess.Popen:
    # Output stays in bridge.log (the bridge's own rotating handler); a pipe or file here would
    # either break when this tick exits or mirror bridge.log forever without rotation.
    kwargs = dict(cwd=str(BRIDGE_DIR), env=env, stdin=subprocess.DEVNULL,
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    cmd = [str(PYTHONW), "bridge.py", "--no-lifecycle"]
    try:
        return subprocess.Popen(cmd, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, **kwargs)
    except OSError:
        return subprocess.Popen(cmd, creationflags=flags, **kwargs)  # job forbids breakaway


def main() -> int:
    if port_up(WS_PORT):
        return 0
    now = time.time()
    if launched_recently(now):
        return 0
    if not PYTHONW.is_file():
        note(f"bridge down; no interpreter at {PYTHONW} (run `uv sync` in bridge/)")
        return 1
    env = clean_env(dict(os.environ))
    problem = preflight(env)
    if problem:
        note(f"bridge down; not starting it, its imports fail: {problem}")
        return 1
    STAMP.write_text(str(now), encoding="utf-8")
    proc = launch(env)
    deadline = time.time() + START_WAIT
    while time.time() < deadline:
        if port_up(WS_PORT):
            note(f"bridge was down on :{WS_PORT}; started pid {proc.pid}")
            return 0
        if proc.poll() is not None:
            note(f"bridge was down; started pid {proc.pid} but it exited with code "
                 f"{proc.returncode} (see bridge.log)")
            return 1
        time.sleep(1)
    note(f"bridge was down; started pid {proc.pid}, not listening after {START_WAIT}s yet")
    return 0


if __name__ == "__main__":
    sys.exit(main())

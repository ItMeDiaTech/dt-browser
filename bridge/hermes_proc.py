"""Detect running Hermes desktop/CLI instances (shared by bridge.py and the watchdog).

Both the desktop app and a CLI session run an executable named ``hermes.exe``;
the always-on gateway is ``python -m hermes_cli.main gateway run`` (python.exe),
so an image-name check is enough.

The always-on gateway deliberately does NOT count: the bridge closes when the
user's actual front-ends (desktop app, CLI sessions) are all closed, even though
the logon gateway keeps running.

Fail-safe: any enumeration error returns True (keep the bridge alive rather
than kill it because detection broke).
"""
from __future__ import annotations

import subprocess
import sys


def any_hermes_instance() -> bool:
    """True if any Hermes desktop or CLI process is running."""
    if sys.platform != "win32":
        return True  # lifecycle is Windows-instance bound; stay up elsewhere
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq hermes.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return True  # fail-safe: never kill the bridge because detection broke
    return out.returncode != 0 or "hermes.exe" in out.stdout.lower()

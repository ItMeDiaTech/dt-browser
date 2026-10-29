#!/usr/bin/env python3
"""Seed an unpacked extension into a Chrome profile's Preferences files.

Chrome 137+ stable removed the --load-extension flag, so the only scriptable way
to install an unpacked extension into a fresh profile is to write its entry into
Default/Preferences and Default/Secure Preferences (both must match).

The unpacked-extension ID is derived from the absolute path: lowercase, '/'
separators, sha256 hex, then each hex digit mapped to a-p (Chromium GenerateId).
Run this with Chrome closed, then launch Chrome with the same --user-data-dir.
"""
import hashlib
import json
import os
import sys


def extension_id(path: str) -> str:
    # Best-effort Chromium unpacked-ID derivation (path, lowercase, '/', sha256,
    # hex -> a-p). Chrome versions may normalize differently; override with --id
    # when a mismatch is observed (the extension still loads — Chrome re-derives
    # the ID from the path and ignores a wrong key).
    norm = path.replace("\\", "/").lower()
    h = hashlib.sha256(norm.encode("utf-8")).hexdigest()
    return "".join(chr(ord("a") + int(c, 16)) for c in h[:32])


def main() -> int:
    if len(sys.argv) not in (3, 5):
        print("usage: seed_extension.py <profile_dir> <extension_dir> [--id <override_id>]")
        return 2
    profile, ext = sys.argv[1], sys.argv[2]
    ext = os.path.abspath(ext)
    eid = extension_id(ext)
    if len(sys.argv) == 5 and sys.argv[3] == "--id":
        eid = sys.argv[4]
    print(f"extension id: {eid}")

    with open(os.path.join(ext, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    entry = {
        "state": 1,  # ENABLED
        "location": 5,  # UNPACKED
        "path": ext,
        "disable_reasons": 0,
        "manifest": {"name": manifest.get("name", ""), "version": manifest.get("version", ""), "manifest_version": manifest.get("manifest_version", 3)},
        "install_time": "2026-08-08T00:00:00.000Z",
        "from_bookmark": False,
        "from_webstore": False,
        "created_from_web_store": False,
        "allow_file_access": True,
    }

    for name in ("Preferences", "Secure Preferences"):
        p = os.path.join(profile, "Default", name)
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("extensions", {}).setdefault("settings", {})[eid] = entry
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)
        print(f"patched {name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

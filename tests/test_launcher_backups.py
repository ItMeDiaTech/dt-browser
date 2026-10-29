from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == "nt", "Windows launcher script")
class LauncherBackupTests(unittest.TestCase):
    def test_rerun_preserves_original_shortcut_and_run_backups(self):
        with tempfile.TemporaryDirectory(prefix="dt-browser-launcher-test-") as directory:
            root = Path(directory)
            shortcut = root / "Desktop/Google Chrome.lnk"
            shortcut.parent.mkdir()
            shortcut.write_text("original shortcut arguments", encoding="utf-8")
            check = root / "check.ps1"
            check.write_text(r'''
$ErrorActionPreference = 'Stop'
$script:fakeRun = 'original run arguments'
function Get-ItemProperty { [pscustomobject]@{ GoogleChromeAutoLaunch_fixture = $script:fakeRun } }
function Set-ItemProperty { param($Path, $Name, $Value) $script:fakeRun = $Value }
function New-Object {
  param($ComObject)
  if ($ComObject -ne 'WScript.Shell') { throw 'unexpected COM object' }
  $shell = [pscustomobject]@{}
  $shell | Add-Member ScriptMethod CreateShortcut {
    param($path)
    $shortcut = [pscustomobject]@{ Path = $path; Arguments = (Get-Content -Raw -LiteralPath $path).Trim() }
    $shortcut | Add-Member ScriptMethod Save { Set-Content -LiteralPath $this.Path -Value $this.Arguments }
    return $shortcut
  }
  return $shell
}
. $env:REVIEW_LAUNCHER_SCRIPT
. $env:REVIEW_LAUNCHER_SCRIPT
$backups = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'dt-browser-launcher-backup') -Filter '*.bak'
if ($backups.Count -ne 1) { throw 'expected one shortcut backup' }
if ((Get-Content -Raw -LiteralPath $backups[0].FullName).Trim() -ne 'original shortcut arguments') { throw 'original shortcut backup overwritten' }
$runBackup = Join-Path $env:LOCALAPPDATA 'dt-browser-launcher-backup/run_GoogleChromeAutoLaunch_fixture.txt'
if ((Get-Content -Raw -LiteralPath $runBackup).Trim() -ne 'original run arguments') { throw 'original Run backup overwritten' }
if ($script:fakeRun -ne 'original run arguments --silent-debugger-extension-api') { throw 'Run flag duplicated or missing' }
''', encoding="utf-8")
            environment = {**os.environ, **{name: directory for name in ("LOCALAPPDATA", "APPDATA", "ProgramData", "USERPROFILE")},
                           "REVIEW_LAUNCHER_SCRIPT": str(ROOT / "scripts/silent-debugger-banner.ps1")}
            result = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(check)],
                                    env=environment, capture_output=True, text=True, timeout=20,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

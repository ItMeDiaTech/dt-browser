# Hide Chrome's "<extension> started debugging this browser" bar by adding Chrome's
# --silent-debugger-extension-api switch to every launcher that can become THE browser process.
#
# Chrome reads that switch only from the first (browser) process: a later chrome.exe joins the
# running instance and its command line is ignored, so the switch must be on the shortcut used to
# start Chrome AND on Chrome's own logon auto-launch Run value. Only --silent-debugger-extension-api
# is honoured here (Chromium: ExtensionDevToolsClientHost::Attach suppresses the infobar when the
# switch is present or the extension is policy-installed); --disable-infobars no longer works.
#
# It hides the bar for EVERY extension holding the debugger permission (Sidecar Monkey, Claude,
# ChatGPT, ...), not just this one. Re-run any time; originals are backed up first. Idempotent.
$flag = '--silent-debugger-extension-api'
$backup = Join-Path $env:LOCALAPPDATA 'dt-browser-launcher-backup'
New-Item -ItemType Directory -Force -Path $backup | Out-Null

$sh = New-Object -ComObject WScript.Shell
$shortcuts = @(
  "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Google Chrome.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk",
  "$env:USERPROFILE\Desktop\Google Chrome.lnk"
)

foreach ($p in $shortcuts) {
  if (-not (Test-Path $p)) { continue }
  $l = $sh.CreateShortcut($p)
  if ($l.Arguments -notlike "*$flag*") {
    $original = Join-Path $backup (($p -replace '[\\/:]', '_') + '.bak')
    if (-not (Test-Path -LiteralPath $original)) { Copy-Item -LiteralPath $p -Destination $original }
    $l.Arguments = ("$($l.Arguments) $flag").Trim()
    $l.Save()
  }
  "lnk  $p`n     -> [$($sh.CreateShortcut($p).Arguments)]"
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$props = Get-ItemProperty $runKey
foreach ($n in ($props.PSObject.Properties.Name | Where-Object { $_ -like 'GoogleChromeAutoLaunch_*' })) {
  $before = $props.$n
  if ($before -notlike "*$flag*") {
    $original = Join-Path $backup "run_$n.txt"
    if (-not (Test-Path -LiteralPath $original)) { Set-Content -LiteralPath $original -Value $before }
    # switch order is irrelevant; appending keeps the quoted exe path and its own switches intact
    Set-ItemProperty -Path $runKey -Name $n -Value ("$before $flag")
  }
  "run  $n`n     -> [$((Get-ItemProperty $runKey).$n)]"
}

"Backups in $backup. A running Chrome keeps the old command line: quit it fully (or chrome://restart) for the switch to take effect."

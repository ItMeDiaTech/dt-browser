' Start the dt-browser bridge without a console window.
' Used by the dt-browser-bridge scheduled task; logs go to bridge\bridge.log.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bridgeDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)) & "\bridge"
sh.CurrentDirectory = bridgeDir
sh.Run "uv run --gui-script bridge.py --no-lifecycle", 0, False

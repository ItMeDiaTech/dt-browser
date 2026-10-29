@echo off
rem Register a Task Scheduler job that starts the dt-browser bridge at logon, with no console
rem window. --no-lifecycle: a bridge started at logon would otherwise exit 30 s later whenever
rem Hermes is not open yet.
schtasks /Create /F /TN "dt-browser-bridge" /TR "wscript.exe \"%~dp0start_bridge_hidden.vbs\"" /SC ONLOGON /RL LIMITED
if errorlevel 1 (
  echo Task install failed.
  exit /b 1
)
echo Task installed. Test with:  schtasks /Run /TN "dt-browser-bridge"

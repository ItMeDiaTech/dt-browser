@echo off
rem Start the dt-browser bridge (foreground). Uses bridge\token.txt if present.
cd /d "%~dp0..\bridge"
uv run python bridge.py %*

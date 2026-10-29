@echo off
rem Stop the dt-browser bridge: the python/pythonw/uv process listening on :18899/:18765, nothing else.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 18899,18765 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match '^(python|pythonw|uv)$') { Stop-Process -Id $_ -Force } elseif ($p) { Write-Host ('left ' + $p.ProcessName + ' (pid ' + $_ + ') running: not the bridge') } }"

@echo off
rem Double-click to install the TaleSpire Map Exporter mod (BepInEx + plugin).
rem Runs install-windows.ps1 without needing to change PowerShell's execution policy.
rem Extra arguments are passed through, e.g.: install-windows.bat -Uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
echo.
pause

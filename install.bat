@echo off
setlocal

set "PLUGIN_ROOT=%~dp0"
set "INSTALLER=%PLUGIN_ROOT%scripts\publish-personal.ps1"

if not exist "%INSTALLER%" (
  echo [ERROR] Missing installer: %INSTALLER%
  exit /b 1
)

echo AIHub Codex Monitor installer
echo Source: %PLUGIN_ROOT%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" -StopRunningMonitor %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Installation failed with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo Installation completed. Restart Codex and create a new task.
pause
exit /b 0

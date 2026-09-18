@echo off
rem StudyTracker (browser edition) - double-click to start.
rem Starts a tiny local web server for the app folder and opens the app in its own window.
rem Nothing is installed and nothing leaves this computer.
setlocal
set "HERE=%~dp0"
start "StudyTracker" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%serve.ps1"
endlocal

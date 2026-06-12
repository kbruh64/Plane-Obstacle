@echo off
rem Launches COMET 88 as a native desktop app (Electron). No server needed.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\electron\dist\electron.exe (
  echo Dependencies missing - running npm install first...
  call npm install
)
start "" node_modules\electron\dist\electron.exe .

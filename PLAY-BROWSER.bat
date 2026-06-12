@echo off
rem Starts the local web server and opens COMET 88 in your browser.
rem KEEP THE SERVER WINDOW OPEN while playing. Close it when done.
cd /d "%~dp0"
if not exist node_modules\.bin\http-server.cmd (
  echo Dependencies missing - running npm install first...
  call npm install
)
start "COMET 88 server - keep open while playing" cmd /k node_modules\.bin\http-server.cmd . -p 5173 -c-1
ping -n 3 127.0.0.1 >nul
start "" http://localhost:5173/index.html

@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js 22 or newer, then try again.
  pause
  exit /b 1
)

if not defined PORT (
  for /f "tokens=1,2 delims==" %%A in ('findstr /r /c:"^PORT=[0-9][0-9]*$" ".env" 2^>nul') do set "PORT=%%B"
)
if not defined PORT set "PORT=3000"

if not exist "node_modules\nodemailer\package.json" (
  echo Installing website dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

curl.exe --silent --fail "http://127.0.0.1:%PORT%/" >nul 2>nul
if not errorlevel 1 (
  echo Nexventa is already running. Opening it in your browser...
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo Starting Nexventa on port %PORT%...
start "Nexventa Website Server" cmd /k "cd /d ""%~dp0"" && npm start"

for /l %%I in (1,1,20) do (
  curl.exe --silent --fail "http://127.0.0.1:%PORT%/" >nul 2>nul
  if not errorlevel 1 goto :open_site
  timeout /t 1 /nobreak >nul
)

echo The site did not respond yet. Check the server window for errors.
echo Keep that window open while you use the website.
pause
exit /b 1

:open_site
echo Nexventa is ready. Opening it in your browser...
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

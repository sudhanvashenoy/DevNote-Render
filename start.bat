@echo off
echo.
echo  KnowBase - Personal Knowledge Hub
echo  ===================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo  ERROR: Node.js not found.
  echo  Please install from https://nodejs.org
  pause
  exit /b
)

if not exist "backend\node_modules" (
  echo  Installing dependencies ^(first run only^)...
  cd backend
  npm install
  cd ..
  echo  Done!
  echo.
)

echo  Starting KnowBase at http://localhost:3333
echo  Press Ctrl+C to stop
echo.

cd backend
node server.js

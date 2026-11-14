@echo off
setlocal EnableExtensions
title Wii U Menu - Compiler
cd /d "%~dp0"

echo ============================================
echo   Wii U Menu - building portable executable
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install it from https://nodejs.org and run this again.
  goto :fail
)

set CSC_IDENTITY_AUTO_DISCOVERY=false
set ELECTRON_BUILDER_COMPRESSION_LEVEL=9

if not exist "node_modules\electron-builder" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

if exist dist rmdir /s /q dist

echo.
echo Building (maximum compression, en-US only)...
call npx electron-builder --win portable --x64
if errorlevel 1 (
  echo.
  echo If you saw a "Cannot create symbolic link" error, turn on Windows Developer Mode
  echo ^(Settings ^> System ^> For developers^) or run this file as Administrator, then retry.
  goto :fail
)

echo.
echo ============================================
echo   Build finished. Output in the dist folder:
echo ============================================
for %%f in (dist\*.exe) do (
  set /a MB=%%~zf/1048576
  call echo   %%~nxf  -  %%MB%% MB
)
echo.
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1

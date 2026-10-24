@echo off
title VSPEED Overlay - go back to the previous version
cd /d "%~dp0"
echo This puts back the version you had before the last update.
echo Your settings, standings, sponsors and logos are not affected.
echo.
choice /c YN /m "Go back to the previous version"
if errorlevel 2 exit /b
python update.py --rollback & pause & exit /b

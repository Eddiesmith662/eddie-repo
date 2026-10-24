@echo off
title VSPEED Overlay (DEMO)
cd /d "%~dp0"
rem The last line runs, pauses and exits in one go on purpose: an update may replace this file while it runs.
where python >nul 2>nul || (echo Python was not found. Install it from python.org and tick "Add Python to PATH". & pause & exit /b 1)
python run.py --demo %* & pause & exit /b

@echo off
title VSPEED Overlay (DEMO QUALIFYING)
cd /d "%~dp0"
rem The last line runs, pauses and exits in one go on purpose: an update may replace this file while it runs.
rem python-setup.bat finds the Python to use (the overlay's own copy, downloaded the first time)
call python-setup.bat || (pause & exit /b 1)
"%PY%" %PYARGS% run.py --demo --qual %* & pause & exit /b

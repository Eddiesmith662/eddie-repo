@echo off
title VSPEED Race Control (iRacing)
cd /d "%~dp0"
rem The last line runs, pauses and exits in one go on purpose: an update may replace this file while it runs.
rem python-setup.bat finds the Python to use (the overlay's own copy, downloaded the first time)
call python-setup.bat || (pause & exit /b 1)
rem The first time: a "VSPEED Race Control" shortcut on the desktop (race-control-shortcut.bat), not again after that
if not exist "data\steward\desktop-shortcut.txt" call "%~dp0race-control-shortcut.bat"
"%PY%" %PYARGS% run.py --race-control %* & pause & exit /b

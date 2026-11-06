@echo off
title VSPEED Overlay tests
cd /d "%~dp0"
rem Runs the overlay's tests: recorded races replayed through the real code, plus the race logic, live points,
rem standings and data-safety checks. They use a throwaway data folder: your settings and standings are never touched.
call python-setup.bat || (pause & exit /b 1)
"%PY%" %PYARGS% -m unittest discover -s tests -t tests %*
pause

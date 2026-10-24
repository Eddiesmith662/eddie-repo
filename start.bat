@echo off
title VSPEED Overlay (iRacing)
cd /d "%~dp0"
python -c "import irsdk" 2>nul || (
  echo Installing pyirsdk...
  python -m pip install pyirsdk
)
python server.py
pause

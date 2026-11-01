@echo off
rem Finds the Python the overlay runs on and puts it in PY (plus PYARGS). The start files call this first.
rem
rem The overlay brings its own Python 3.13, so nobody has to install Python or pick the right version. The first time,
rem it's downloaded (about 30 MB, checked against a fixed checksum) into %LOCALAPPDATA%\VSPEED, outside the overlay
rem folder so OneDrive doesn't sync it and every copy of the overlay shares it. After that it starts straight away.
rem Delete %LOCALAPPDATA%\VSPEED to remove it. If the download isn't possible, an installed Python is used instead.

set "PYBUILD=3.13.16+20261013"
set "PYURL=https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16%%2B20261013-x86_64-pc-windows-msvc-install_only.tar.gz"
set "PYSHA=e1f9233e780fbe951e531b0eb207d794e1c3fb39d523a6f481f4fc01ef2b6ca5"
set "PYHOME=%LOCALAPPDATA%\VSPEED\python-%PYBUILD%"
set "PY=%PYHOME%\python.exe"
set "PYARGS="
if exist "%PY%" exit /b 0

echo Setting up Python for the overlay (one time only, about 30 MB). This takes a minute or two...
set "PYTMP=%LOCALAPPDATA%\VSPEED\download"
if exist "%PYTMP%" rd /s /q "%PYTMP%"
mkdir "%PYTMP%" 2>nul
set "PYZIP=%PYTMP%\python.tar.gz"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:PYURL -OutFile $env:PYZIP; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $env:PYZIP).Hash -ne $env:PYSHA) { throw 'the download did not match its checksum' }"
if errorlevel 1 goto fallback
rem Windows' own tar (another tar on PATH, e.g. Git's, can't handle C:\ paths)
"%SystemRoot%\System32\tar.exe" -xzf "%PYZIP%" -C "%PYTMP%"
if errorlevel 1 goto fallback
if not exist "%PYTMP%\python\python.exe" goto fallback
rem only a complete copy gets the final name, so a half-finished setup is never used
if exist "%PYHOME%" rd /s /q "%PYHOME%"
move "%PYTMP%\python" "%PYHOME%" >nul
if errorlevel 1 goto fallback
rd /s /q "%PYTMP%"
echo Python is ready.
exit /b 0

:fallback
if exist "%PYTMP%" rd /s /q "%PYTMP%"
echo.
echo Couldn't set up the overlay's own Python (no internet connection?). Trying an installed Python instead.
set "PYARGS="
where py >nul 2>nul
if errorlevel 1 goto plain
py -3.13 --version >nul 2>nul
if errorlevel 1 goto plain
set "PY=py"
set "PYARGS=-3.13"
exit /b 0
:plain
where python >nul 2>nul
if errorlevel 1 goto none
set "PY=python"
exit /b 0
:none
echo Python was not found either. Check the internet connection and run this again.
exit /b 1

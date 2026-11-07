@echo off
rem Puts a "VSPEED Race Control" shortcut on the desktop: it starts race control with its black window minimized, so
rem a steward only sees the Race Control page open in the browser. start-race-control.bat calls this the first time it
rem runs (and notes that in data\steward, so a shortcut the steward deletes doesn't come back); double-click this file
rem to make the shortcut again, for example after moving the overlay folder.
setlocal
set "RCDIR=%~dp0"
if "%RCDIR:~-1%"=="\" set "RCDIR=%RCDIR:~0,-1%"
rem The desktop is asked of Windows, so a desktop that OneDrive has moved is found too (VSPEED_DESKTOP, for tests, puts
rem it somewhere else). WindowStyle 7 = minimized.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $d = if ($env:VSPEED_DESKTOP) { $env:VSPEED_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }; $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'VSPEED Race Control.lnk')); $s.TargetPath = Join-Path $env:RCDIR 'start-race-control.bat'; $s.WorkingDirectory = $env:RCDIR; $s.WindowStyle = 7; $s.IconLocation = (Join-Path $env:RCDIR 'static\assets\race-control.ico') + ',0'; $s.Description = 'Start VSPEED race control'; $s.Save(); exit 0 } catch { exit 1 }"
if errorlevel 1 goto failed
echo Put a "VSPEED Race Control" shortcut on your desktop: use it to start race control from now on.
if not exist "%RCDIR%\data\steward" mkdir "%RCDIR%\data\steward" 2>nul
> "%RCDIR%\data\steward\desktop-shortcut.txt" echo The desktop shortcut was made %DATE% %TIME%. Delete this file to have start-race-control.bat make it again.
exit /b 0

:failed
echo Couldn't put the VSPEED Race Control shortcut on the desktop. Race control still works: start it with
echo start-race-control.bat in "%RCDIR%"
exit /b 1

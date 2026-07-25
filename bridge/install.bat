@echo off
REM ===================================================================
REM  Agamani attendance bridge - one-time setup for the shop PC.
REM
REM  Installs what the sync needs, finds the fingerprint machine on the
REM  network, and schedules the sync to run by itself every 5 minutes.
REM
REM  Nothing here changes the fingerprint machine. Attendance Master and
REM  the vendor portal keep working exactly as they do now.
REM
REM  Right-click this file -> "Run as administrator".
REM ===================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo   Agamani attendance sync - setup
echo   ================================
echo.

REM ---- 1. Python -----------------------------------------------------
python --version >nul 2>&1
if errorlevel 1 (
    echo   Python is not installed on this PC.
    echo.
    echo   Please install it once from:  https://www.python.org/downloads/
    echo   IMPORTANT: on the first screen, tick "Add python.exe to PATH".
    echo.
    echo   Then run this file again.
    echo.
    pause
    exit /b 1
)
echo   [1/5] Python found.

REM ---- 2. Dependencies ----------------------------------------------
echo   [2/5] Installing the two libraries it needs...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo.
    echo   Could not install the libraries. Check this PC's internet connection.
    pause
    exit /b 1
)

REM ---- 3. Settings ---------------------------------------------------
REM  The serial and port are known already (they are on the machine and
REM  in our records, and they are not secrets), and the IP is discovered
REM  automatically. So there is exactly one thing to ask for. Anything
REM  unusual can still be changed afterwards by editing config.json.
set SERIAL=RGS2022036320
set DEVPORT=5005

if exist config.json (
    REM  Normal case: the bundle was built with make_client_bundle.ps1,
    REM  so the settings arrived filled in and there is nothing to ask.
    echo   [3/5] Settings already in place - nothing to enter.
) else (
    echo   [3/5] One thing needed, asked only this once.
    echo.
    echo         Paste the setup key Rishab sent you, then press Enter.
    echo         ^(Right-click in this window to paste.^)
    echo.
    set /p SECRET="        Setup key: "

    if "!SECRET!"=="" (
        echo.
        echo   No key entered - nothing has been set up. Run this again
        echo   once you have the key.
        echo.
        pause
        exit /b 1
    )

    >config.json echo {
    >>config.json echo   "device_ip": "",
    >>config.json echo   "device_port": !DEVPORT!,
    >>config.json echo   "device_serial": "!SERIAL!",
    >>config.json echo   "function_url": "https://zhekzbooxkuosolubdjd.supabase.co/functions/v1/adms",
    >>config.json echo   "shared_secret": "!SECRET!",
    >>config.json echo   "lookback_days": 10
    >>config.json echo }
)

REM ---- 4. First run --------------------------------------------------
echo.
echo   [4/5] Testing the connection to the machine...
echo.
python pyzk_bridge.py
if errorlevel 1 (
    echo.
    echo   The test did not succeed - see the message above.
    echo   Nothing has been scheduled. Fix the problem and run this again.
    echo.
    pause
    exit /b 1
)

REM ---- 5. Schedule ---------------------------------------------------
echo.
echo   [5/5] Scheduling it to run every minute...

REM  Point the task at the full path of pythonw.exe rather than the bare
REM  word "python". A scheduled task does not always inherit the PATH
REM  that this window has, so "python" can resolve here and then fail
REM  silently every minute afterwards. pythonw runs without a console
REM  window, which is why no wrapper script is needed.
set PYEXE=
for /f "delims=" %%i in ('where python 2^>nul') do if not defined PYEXE set PYEXE=%%i
if not defined PYEXE (
    echo   Could not locate python.exe. Reinstall Python with
    echo   "Add python.exe to PATH" ticked.
    pause
    exit /b 1
)
set PYW=%PYEXE:python.exe=pythonw.exe%
if not exist "%PYW%" set PYW=%PYEXE%

schtasks /Query /TN "AgamaniAttendanceSync" >nul 2>&1
if not errorlevel 1 schtasks /Delete /TN "AgamaniAttendanceSync" /F >nul 2>&1

schtasks /Create ^
    /TN "AgamaniAttendanceSync" ^
    /TR "\"%PYW%\" \"%~dp0pyzk_bridge.py\"" ^
    /SC MINUTE /MO 1 ^
    /RU "%USERNAME%" ^
    /RL LIMITED ^
    /F >nul
if errorlevel 1 (
    echo.
    echo   Could not create the scheduled task.
    echo   Please right-click install.bat and choose "Run as administrator".
    pause
    exit /b 1
)

echo.
echo   ================================================================
echo    Done. Attendance now syncs by itself every 5 minutes.
echo.
echo    - Leave this PC on during shop hours.
echo    - If it is off for a while, nothing is lost: the machine keeps
echo      its own record and the next sync catches up, with each punch
echo      keeping its real time.
echo    - A record of each sync is written to bridge.log in this folder.
echo   ================================================================
echo.
pause

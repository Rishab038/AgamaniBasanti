@echo off
REM ===================================================================
REM  Shows what the attendance sync is actually doing.
REM
REM  The scheduled run is deliberately invisible, so when something
REM  breaks there is nothing on screen to see. Double-click this to run
REM  the same job in the open, with every error shown.
REM
REM  Take a photo of this window and send it to Rishab.
REM ===================================================================
cd /d "%~dp0"

echo.
echo   Agamani attendance sync - status check
echo   ======================================
echo.

echo   [1] Is the automatic sync scheduled?
echo   -------------------------------------
schtasks /Query /TN "AgamaniAttendanceSync" /FO LIST 2>nul | findstr /I "TaskName Status Next Last Result"
if errorlevel 1 echo        NOT SCHEDULED - setup did not finish. Run install.bat again.
echo.

echo   [2] Can this PC reach the Agamani server?
echo   ------------------------------------------
ping -n 2 zhekzbooxkuosolubdjd.supabase.co >nul 2>&1
if errorlevel 1 (
    echo        NO - this PC has no working internet, or a firewall is blocking it.
) else (
    echo        Yes.
)
echo.

echo   [3] Last few lines of the sync log
echo   ----------------------------------
if exist bridge.log (
    powershell -NoProfile -Command "Get-Content bridge.log -Tail 12"
) else (
    echo        No log file yet - the sync has never actually run.
)
echo.

echo   [4] Running the sync now, in the open
echo   -------------------------------------
echo.
python pyzk_bridge.py
echo.
if errorlevel 1 (
    echo   ^>^> IT FAILED. The reason is in the message just above.
) else (
    echo   ^>^> It worked. Attendance is reaching the dashboard.
)
echo.
echo   ======================================================
echo    Please send a photo of this whole window to Rishab.
echo   ======================================================
echo.
pause

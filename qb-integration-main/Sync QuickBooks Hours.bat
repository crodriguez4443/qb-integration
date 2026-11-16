@echo off
REM ===================================================================
REM  ConSysTec QuickBooks Sync - double-click THIS file to run.
REM ===================================================================
REM
REM  Why this file exists:
REM
REM  When this folder arrives as a .zip, Windows tags every file inside
REM  it as "came from the internet" (Mark of the Web). PowerShell then
REM  refuses to run the .ps1 launcher at all - it rejects the file
REM  before the first line executes, so the window flashes and closes
REM  with no readable error and nothing written to any log.
REM
REM  A .bat file is not subject to that restriction, so this one can
REM  clear the tag and then start the real launcher. Two steps:
REM
REM    1. Unblock-File on this folder's own files (not node_modules -
REM       nothing in there is executed as a script, and walking it
REM       would add thousands of files for no benefit).
REM    2. Run the .ps1 with -ExecutionPolicy Bypass, so the machine's
REM       own policy setting cannot block it either.
REM
REM  If you prefer, the old way still works: right-click
REM  "Sync QuickBooks Hours.ps1" -> Run with PowerShell. But you would
REM  have to unblock the files yourself first (right-click the .zip ->
REM  Properties -> Unblock, BEFORE extracting).
REM ===================================================================

echo Preparing files...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%~dp0' -File | Unblock-File -ErrorAction SilentlyContinue"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync QuickBooks Hours.ps1"

REM The .ps1 does its own "press Enter to close" pause, so if it ran at
REM all we do not need another one. This pause only matters when the
REM .ps1 could not be started at all - without it that error would
REM scroll past and vanish, which is the exact problem this file exists
REM to prevent.
if errorlevel 1 (
  echo.
  echo The launcher exited with an error ^(code %errorlevel%^).
  echo Check sync-log.txt and agent-output.txt in this folder.
  pause
)

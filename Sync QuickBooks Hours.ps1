# ConSysTec QuickBooks Sync Agent - launcher
# To run: right-click this file -> "Run with PowerShell".
#
# If this window ever closes before you can read it, open the two log files
# it writes next to this script:
#     sync-log.txt        - this launcher's own messages and any error
#     agent-output.txt     - everything the sync agent (node) prints
# Send both to Chris.

Set-Location -Path $PSScriptRoot

$LogFile     = Join-Path $PSScriptRoot 'sync-log.txt'
$AgentOut    = Join-Path $PSScriptRoot 'agent-output.txt'
$AgentErr    = Join-Path $PSScriptRoot 'agent-error.txt'
$PORT        = 8090

# Capture this launcher's own console output to a file, so a crash that closes
# the window still leaves something to read. This does NOT capture node's
# output - that is what $AgentOut / $AgentErr below are for.
try { Start-Transcript -Path $LogFile -Force | Out-Null } catch {}

function Pause-AndExit($code) {
    Write-Host ""
    Write-Host "Press Enter to close this window..."
    try { Read-Host | Out-Null } catch { Start-Sleep -Seconds 30 }
    try { Stop-Transcript | Out-Null } catch {}
    exit $code
}

# Any error anywhere below lands here, gets printed and logged, and the window
# waits for Enter instead of vanishing.
trap {
    Write-Host ""
    Write-Host "====================================================" -ForegroundColor Red
    Write-Host " SOMETHING WENT WRONG" -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host ($_.InvocationInfo.PositionMessage)
    Write-Host ""
    Write-Host "This message was also saved to:"
    Write-Host "    $LogFile"
    Write-Host "Send that file (and agent-output.txt if it exists) to Chris."
    Pause-AndExit 1
}

$ErrorActionPreference = 'Stop'

Write-Host "===================================================="
Write-Host " ConSysTec QuickBooks Sync"
Write-Host "===================================================="
Write-Host ""

# Check Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed on this computer." -ForegroundColor Red
    Write-Host ""
    Write-Host "This only needs to be done once. Install it from:"
    Write-Host "    https://nodejs.org  (choose the LTS version)"
    Write-Host ""
    Write-Host "Then come back and run this script again."
    Pause-AndExit 1
}

# --- Fixed configuration (do not need to be changed) ---
$env:APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzjYKhai8yyCYq8JbNPGS_crPqXvvbqJGewm-SKxPRehiWt_qtmrG1vDcaUJt9oyab4ww/exec"
$env:QBD_PUSH_SECRET = "abc123"

# How far back to pull time entries is now baked into server1.3.js: it pulls
# 3 whole calendar years (from 1 January of three years ago) automatically,
# with no env var needed. Only override this for a one-off backfill, and only
# after checking the row count still fits under MAX_RETURNED.TimeTracking
# (40000 in server1.3.js) - qbXML gives NO indication when it truncates, and
# ConSysTec logs roughly 530 time entries a month, so ~6 years is the ceiling.
#   $env:YEARS_BACK = "3"

# --- Clear out a previous agent that is still running on the port ---------
# If a previous run's window was closed with the X instead of pressing Enter,
# the node agent keeps running. A second agent cannot bind the same port, so
# it would start and immediately die. Stop the old one first.
$stale = $null
try {
    $stale = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
} catch {}
if ($stale) {
    foreach ($conn in @($stale)) {
        $owner = $null
        try { $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue } catch {}
        if ($owner -and $owner.ProcessName -eq 'node') {
            Write-Host "Found a previous sync agent still running (process $($owner.Id)). Stopping it..."
            try { Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue } catch {}
            Start-Sleep -Seconds 1
        } else {
            $who = if ($owner) { "$($owner.ProcessName) (process $($owner.Id))" } else { "process $($conn.OwningProcess)" }
            Write-Host "Port $PORT is already in use by $who, which is not the sync agent." -ForegroundColor Red
            Write-Host "Close that program (or restart the computer) and run this again."
            Pause-AndExit 1
        }
    }
}

Write-Host "Starting the connection to QuickBooks..."
Write-Host ""

# node's own output goes to files so a startup failure is never invisible.
Remove-Item $AgentOut, $AgentErr -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath node -ArgumentList 'server1.3.js' -NoNewWindow -PassThru `
    -RedirectStandardOutput $AgentOut -RedirectStandardError $AgentErr

if ($null -eq $proc) {
    Write-Host "Could not start the agent process at all." -ForegroundColor Red
    Write-Host "Check that Node.js is installed correctly (see https://nodejs.org)."
    Pause-AndExit 1
}

Start-Sleep -Seconds 3

if ($proc.HasExited) {
    Write-Host "The connection failed to start." -ForegroundColor Red
    Write-Host ""
    Write-Host "--- what the agent printed --------------------------------------"
    Get-Content $AgentOut -ErrorAction SilentlyContinue
    Get-Content $AgentErr -ErrorAction SilentlyContinue
    Write-Host "----------------------------------------------------------------"
    Write-Host ""
    Write-Host "Send a screenshot of this window (and agent-output.txt) to Chris."
    Pause-AndExit 1
}

# Show the agent's startup lines (which URL it will push to, etc.)
Get-Content $AgentOut -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "===================================================="
Write-Host " Now do these two things:" -ForegroundColor Yellow
Write-Host "===================================================="
Write-Host " 1. In QuickBooks Web Connector, check the box for"
Write-Host "    'ConSysTec Hours Sync' and click 'Update Now'."
Write-Host ""
Write-Host " 2. In the Google Sheet, click the QuickBooks menu,"
Write-Host "    then click 'Refresh Hours'."
Write-Host "===================================================="
Write-Host ""
Write-Host "The agent is logging to:"
Write-Host "    $AgentOut"
Write-Host "Open that file any time to see what happened on the last sync."
Write-Host ""

Read-Host "When both of those are done, press Enter here to stop"

Write-Host ""
Write-Host "Stopping..."
if (($null -ne $proc) -and (-not $proc.HasExited)) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
}

Write-Host ""
Write-Host "--- result of the last sync (from agent-output.txt) -------------"
Get-Content $AgentOut -Tail 40 -ErrorAction SilentlyContinue
Write-Host "----------------------------------------------------------------"
Write-Host ""
Write-Host "Done. If 'QBO Unmapped' in the Sheet isn't empty, or the lines"
Write-Host "above mention a problem, send agent-output.txt to Chris."
Pause-AndExit 0

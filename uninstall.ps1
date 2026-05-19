# Spotify A-B Loop Uninstaller
# Restores xpui.spa from the backup made by install.ps1

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$spotifyApps = Join-Path $env:APPDATA 'Spotify\Apps'
$spaPath     = Join-Path $spotifyApps 'xpui.spa'
$bakPath     = "$spaPath.bak"

function Write-Step($msg) { Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; Read-Host 'Press Enter to exit'; exit 1 }

Write-Host ''
Write-Host '  Spotify A-B Loop Uninstaller' -ForegroundColor White
Write-Host '  ----------------------------' -ForegroundColor DarkGray
Write-Host ''

# -- Pre-flight checks -------------------------------------------------------
if (-not (Test-Path $spotifyApps)) {
    Write-Fail "Spotify Apps folder not found at: $spotifyApps"
}

if (-not (Test-Path $bakPath)) {
    # Check if xpui.spa even exists and has our patch
    if (Test-Path $spaPath) {
        Add-Type -Assembly 'System.IO.Compression.FileSystem'
        $zip = [System.IO.Compression.ZipFile]::OpenRead($spaPath)
        $hasLoop = $zip.Entries | Where-Object { $_.FullName -eq 'ab-loop.js' }
        $zip.Dispose()
        if ($hasLoop) {
            Write-Fail "Patch is present but no backup found at: $bakPath`n  Cannot safely restore. Reinstall Spotify to get a clean xpui.spa."
        } else {
            Write-Host '  Nothing to uninstall -- Spotify A-B Loop patch not detected.' -ForegroundColor Yellow
            Write-Host ''
            Read-Host 'Press Enter to exit'
            exit 0
        }
    } else {
        Write-Fail "xpui.spa not found at: $spaPath"
    }
}

# -- Stop Spotify ------------------------------------------------------------
Write-Step 'Stopping Spotify...'
$procs = Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Write-Ok 'Spotify stopped'
} else {
    Write-Ok 'Spotify was not running'
}

# -- Restore backup ----------------------------------------------------------
Write-Step 'Restoring original xpui.spa from backup...'
Copy-Item -Path $bakPath -Destination $spaPath -Force
Write-Ok 'xpui.spa restored'

# -- Remove backup -----------------------------------------------------------
Write-Step 'Removing backup file...'
Remove-Item -Path $bakPath -Force
Write-Ok 'Backup removed'

# -- Done --------------------------------------------------------------------
Write-Host ''
Write-Host '  Done! Spotify A-B Loop has been removed.' -ForegroundColor Green
Write-Host '  Launch Spotify normally -- it is back to stock.' -ForegroundColor DarkGray
Write-Host ''
Read-Host 'Press Enter to exit'
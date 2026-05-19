# Spotify A-B Loop Installer
# Patches %AppData%\Spotify\Apps\xpui.spa to inject ab-loop.js

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Paths -------------------------------------------------------------------
$spotifyApps = Join-Path $env:APPDATA 'Spotify\Apps'
$spaPath     = Join-Path $spotifyApps 'xpui.spa'
$bakPath     = "$spaPath.bak"
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$loopJs      = Join-Path $scriptDir 'ab-loop.js'

# -- Helpers -----------------------------------------------------------------
function Write-Step($msg) { Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

Add-Type -Assembly 'System.IO.Compression'
Add-Type -Assembly 'System.IO.Compression.FileSystem'

# -- Pre-flight checks -------------------------------------------------------
Write-Host ''
Write-Host '  Spotify A-B Loop Installer' -ForegroundColor White
Write-Host '  --------------------------' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $spaPath)) {
    Write-Fail "xpui.spa not found at: $spaPath -- Make sure Spotify is installed from spotify.com (not Microsoft Store)."
}
if (-not (Test-Path $loopJs)) {
    Write-Fail "ab-loop.js not found at: $loopJs -- Place both files in the same folder."
}

# -- Stop Spotify ------------------------------------------------------------
Write-Step 'Stopping Spotify...'
Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Write-Ok 'Spotify stopped'

# -- Backup ------------------------------------------------------------------
Write-Step 'Backing up xpui.spa...'
if (-not (Test-Path $bakPath)) {
    Copy-Item -Path $spaPath -Destination $bakPath
    Write-Ok "Backup saved to xpui.spa.bak"
} else {
    Write-Ok "Backup already exists -- skipping"
}

# -- Open the ZIP ------------------------------------------------------------
Write-Step 'Opening xpui.spa...'
$zip = [System.IO.Compression.ZipFile]::Open($spaPath, 'Update')

function Read-ZipEntry($z, $name) {
    $entry = $z.Entries | Where-Object { $_.FullName -eq $name } | Select-Object -First 1
    if (-not $entry) { return $null }
    $sr = New-Object System.IO.StreamReader($entry.Open())
    $content = $sr.ReadToEnd()
    $sr.Close()
    return $content
}

function Write-ZipEntry($z, $name, $content) {
    $existing = $z.Entries | Where-Object { $_.FullName -eq $name } | Select-Object -First 1
    if ($existing) { $existing.Delete() }
    $entry  = $z.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($entry.Open())
    $writer.Write($content)
    $writer.Close()
}

# -- Check if already patched ------------------------------------------------
$existingLoop = $zip.Entries | Where-Object { $_.FullName -eq 'ab-loop.js' }
if ($existingLoop) {
    Write-Host '  Already patched -- reinstalling ab-loop.js...' -ForegroundColor Yellow
}

# -- Inject ab-loop.js -------------------------------------------------------
Write-Step 'Injecting ab-loop.js...'
$loopContent = Get-Content -Path $loopJs -Raw -Encoding UTF8
Write-ZipEntry $zip 'ab-loop.js' $loopContent
Write-Ok 'ab-loop.js added to xpui.spa'

# -- Patch index.html --------------------------------------------------------
Write-Step 'Patching index.html...'
$indexHtml = Read-ZipEntry $zip 'index.html'

if ($null -eq $indexHtml) {
    $zip.Dispose()
    Write-Fail "index.html not found inside xpui.spa. Your Spotify version may have a different structure."
}

$scriptTag = '<script defer="defer" src="/ab-loop.js"></script>'

if ($indexHtml -like "*ab-loop.js*") {
    Write-Ok "index.html already has script tag -- leaving as-is"
} elseif ($indexHtml -like '*</body>*') {
    $indexHtml = $indexHtml -replace '</body>', "$scriptTag`n</body>"
    Write-ZipEntry $zip 'index.html' $indexHtml
    Write-Ok "Script tag injected before </body>"
} elseif ($indexHtml -like '*</head>*') {
    $indexHtml = $indexHtml -replace '</head>', "$scriptTag`n</head>"
    Write-ZipEntry $zip 'index.html' $indexHtml
    Write-Ok "Script tag injected before </head>"
} else {
    $indexHtml = $indexHtml + "`n$scriptTag"
    Write-ZipEntry $zip 'index.html' $indexHtml
    Write-Ok "Script tag appended to index.html"
}

# -- Close ZIP ---------------------------------------------------------------
$zip.Dispose()
Write-Ok 'xpui.spa saved'

# -- Done --------------------------------------------------------------------
Write-Host ''
Write-Host '  Done! Launch Spotify -- you will see [A] [B] loop and clear buttons in the player bar.' -ForegroundColor Green
Write-Host '  To uninstall, run uninstall.ps1' -ForegroundColor DarkGray
Write-Host ''
Read-Host 'Press Enter to exit'
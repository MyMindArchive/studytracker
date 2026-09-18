# StudyTracker local server. Serves the "app" folder next to this script on
# http://localhost:4173 and opens the app in an app-style browser window.
# The port is fixed on purpose: the browser keeps your data per address, so a
# different port would look like an empty database.
param(
  [int]$Port = 4173,
  [string]$Root = (Join-Path $PSScriptRoot 'app'),
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = "StudyTracker - close this window to stop" } catch {}
$url = "http://localhost:$Port/"
$Root = [IO.Path]::GetFullPath($Root)

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
  '.css' = 'text/css'; '.wasm' = 'application/wasm'; '.json' = 'application/json'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.webp' = 'image/webp'
  '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.ttf' = 'font/ttf'; '.map' = 'application/json'
  '.txt' = 'text/plain; charset=utf-8'
}

function Open-App([string]$u) {
  if ($NoBrowser) { return }
  # Prefer an "app" window (no tabs/address bar) in Edge or Chrome; fall back to the default browser.
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($browser) {
    # A dedicated profile keeps StudyTracker's data separate from normal browsing
    # and stops the browser's "first run" screens from appearing.
    $profile = Join-Path $env:LOCALAPPDATA 'StudyTracker\browser-profile'
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    Start-Process -FilePath $browser -ArgumentList @("--app=$u", "--user-data-dir=`"$profile`"", "--no-first-run", "--no-default-browser-check", "--window-size=1280,820") | Out-Null
  } else {
    Start-Process $u | Out-Null
  }
}

# Already running (this script started earlier and its window is still open)? Just open the app again.
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  $err = $_.Exception.Message
  $alive = $false
  try { $alive = ((Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3).StatusCode -eq 200) } catch {}
  if ($alive) {
    Write-Host "StudyTracker is already running on $url - opening it."
    Open-App $url
    Start-Sleep -Seconds 2
    exit 0
  }
  Write-Host "Could not start the local server on $url"
  Write-Host $err
  Write-Host "Another program may be using port $Port. Close it and run StudyTracker.cmd again."
  Read-Host "Press Enter to close"
  exit 1
}

if (-not (Test-Path (Join-Path $Root 'index.html'))) {
  Write-Host "Cannot find the app files in $Root"
  Write-Host "Keep StudyTracker.cmd, serve.ps1 and the 'app' folder together."
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "  StudyTracker is running at $url"
Write-Host "  Your data is stored in this computer's browser profile:"
Write-Host "  $env:LOCALAPPDATA\StudyTracker\browser-profile"
Write-Host "  Use Settings > Export .xlsx / Download .db for backups."
Write-Host ""
Write-Host "  Keep this window open while you use the app. Close it to stop."
Write-Host ""
Open-App $url

$pending = $listener.GetContextAsync()
while ($listener.IsListening) {
  if (-not $pending.Wait(250)) { continue }
  $ctx = $pending.Result
  $pending = $listener.GetContextAsync()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $Root ($path.TrimStart('/') -replace '/', '\')))
    if (-not $file.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
    } elseif (Test-Path -LiteralPath $file -PathType Leaf) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}

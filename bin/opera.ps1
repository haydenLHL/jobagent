# Windows: bring up Opera on CDP 9222 with a dedicated jobagent profile.
# Idempotent. Run from the repo folder:  powershell -ExecutionPolicy Bypass -File bin\opera.ps1
# First run only: in the Opera window it opens, install the JobRight extension
# and log in to JobRight yourself. The profile keeps both for later runs.
# A separate profile is required: Chromium browsers refuse remote debugging
# on your everyday profile.
$ErrorActionPreference = 'SilentlyContinue'
# 127.0.0.1, not localhost: localhost can resolve to IPv6 ::1 first, where the
# debugging port is not listening.
function Test-Cdp { try { Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:9222/json/version } catch { $null } }

$v = Test-Cdp
if ($v) { Write-Host "CDP already up on 9222: $($v.Browser)"; exit 0 }

# If your everyday Opera is running, a new launch just opens a window in it and
# the debugging flag is silently dropped. It has to be fully closed first.
if (Get-Process opera -ErrorAction SilentlyContinue) {
  Write-Host 'Opera is already running. It must be fully closed so the agent can open its own copy.' -ForegroundColor Yellow
  $a = Read-Host 'Close all Opera windows now? Unsaved tabs are restored next time you open Opera. (y/n)'
  if ($a -ne 'y') { Write-Error 'Close Opera (also check the system tray by the clock), then run again.'; exit 1 }
  Get-Process opera | Stop-Process -Force
  Start-Sleep -Seconds 3
}

# Prefer the real browser binary inside the versioned folder: the top-level
# opera.exe is a launcher that can hand off to an existing instance.
$roots = @("$env:LOCALAPPDATA\Programs\Opera", "$env:LOCALAPPDATA\Programs\Opera GX", "$env:ProgramFiles\Opera")
$exe = $env:OPERA_EXE
if (-not $exe) {
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $ver = Get-ChildItem $r -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path "$($_.FullName)\opera.exe") } |
      Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if ($ver) { $exe = "$($ver.FullName)\opera.exe"; break }
    if (Test-Path "$r\opera.exe") { $exe = "$r\opera.exe"; break }
  }
}
if (-not $exe -or -not (Test-Path $exe)) { Write-Error "Opera not found. Set OPERA_EXE to the full path of opera.exe."; exit 1 }
Write-Host "Starting $exe"

$profileDir = Join-Path (Get-Location) 'opera-profile'
Start-Process -FilePath $exe -ArgumentList @(
  '--remote-debugging-port=9222',
  "--user-data-dir=`"$profileDir`"",
  '--no-first-run', '--no-default-browser-check'
)
# A brand-new profile can take a while on first launch.
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $v = Test-Cdp
  if ($v) { Write-Host "CDP up on 9222: $($v.Browser)"; exit 0 }
}
Write-Error "Opera started but the agent can't connect to it. In that Opera window, open http://127.0.0.1:9222/json/version and send a screenshot of what it shows."
exit 1

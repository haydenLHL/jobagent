# Windows: bring up Opera on CDP 9222 with a dedicated jobagent profile.
# Idempotent. Run from the repo folder:  powershell -ExecutionPolicy Bypass -File bin\opera.ps1
# First run only: in the Opera window it opens, install the JobRight extension
# and log in to JobRight yourself. The profile keeps both for later runs.
# A separate profile is required: Chromium browsers refuse remote debugging
# on your everyday profile.
$ErrorActionPreference = 'SilentlyContinue'
function Test-Cdp { try { Invoke-RestMethod -TimeoutSec 2 http://localhost:9222/json/version } catch { $null } }

$v = Test-Cdp
if ($v) { Write-Host "CDP already up on 9222: $($v.Browser)"; exit 0 }

$exe = @(
  $env:OPERA_EXE,
  "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
  "$env:LOCALAPPDATA\Programs\Opera GX\opera.exe",
  "$env:ProgramFiles\Opera\opera.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { Write-Error "Opera not found. Set OPERA_EXE to the full path of opera.exe."; exit 1 }

$profileDir = Join-Path (Get-Location) 'opera-profile'
Start-Process -FilePath $exe -ArgumentList @(
  '--remote-debugging-port=9222',
  "--user-data-dir=`"$profileDir`"",
  '--no-first-run', '--no-default-browser-check'
)
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  $v = Test-Cdp
  if ($v) { Write-Host "CDP up on 9222: $($v.Browser)"; exit 0 }
}
Write-Error "FAILED to bring up CDP on 9222. Close every Opera window and try again."
exit 1

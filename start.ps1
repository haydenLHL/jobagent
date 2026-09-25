# One-click runner for Windows. Right-click this file -> "Run with PowerShell".
#   (default)  set up, open Opera, find Canadian jobs, fill forms WITHOUT submitting
#   -Submit    same, but actually submit EASY APPLY applications
param([switch]$Submit)
# 'Continue': under 'Stop', Windows PowerShell 5.1 aborts on any stderr line from node/npm.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Stop-With($m) { Write-Host "`n$m" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js (a window may ask for permission)...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-With 'Node.js installed. Close this window and run start.ps1 again.' }
}
if (-not (Test-Path node_modules\playwright-core)) {
  Step 'Installing packages'
  npm install --registry=https://registry.npmjs.org
  if (-not (Test-Path node_modules\playwright-core)) { Stop-With 'Package install failed (see the message above). Check your internet connection and run again.' }
}

Step 'Checking your files'
$dl = Join-Path $env:USERPROFILE 'Downloads'
if (-not (Test-Path answers.json) -and (Test-Path "$dl\answers.json")) { Copy-Item "$dl\answers.json" . ; Write-Host 'Copied answers.json from Downloads' }
if (-not (Test-Path answers.json)) { Stop-With "answers.json is missing. Put it in $PSScriptRoot or your Downloads folder." }
try { $me = Get-Content answers.json -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Stop-With "answers.json has a typo (usually a missing comma or quote): $($_.Exception.Message)" }
if (-not (Test-Path resume.pdf)) {
  # Only a PDF with YOUR last name in the file name - never someone else's resume.
  $r = Get-ChildItem $dl -Filter "*$($me.last_name)*.pdf" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'resume|cv' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $r) { Stop-With "resume.pdf is missing. Copy your resume PDF into $PSScriptRoot and rename it resume.pdf." }
  Write-Host "Found $($r.Name) in Downloads." -ForegroundColor Yellow
  if ((Read-Host 'Use this as your resume? (y/n)') -ne 'y') { Stop-With "Copy your resume PDF into $PSScriptRoot and rename it resume.pdf, then run again." }
  Copy-Item $r.FullName resume.pdf
}
Write-Host "Applying as $($me.first_name) $($me.last_name) with resume.pdf in $PSScriptRoot"

Step 'Checking Claude Code (answers unusual form questions)'
# The native installer's folder is often not on PATH until Windows restarts,
# and an npm install only exposes claude.cmd, which can't be run without a
# shell - so look in the known places and prefer the real program.
$npmCli = "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\cli.js"
$cands = @(
  "$env:USERPROFILE\.local\bin\claude.exe",
  "$env:LOCALAPPDATA\Programs\claude\claude.exe",
  "$env:LOCALAPPDATA\AnthropicClaude\claude.exe",
  (Get-Command claude.exe -ErrorAction SilentlyContinue).Source,
  $npmCli
) | Where-Object { $_ -and (Test-Path $_) }
if ($cands) { $env:CLAUDE_BIN = @($cands)[0]; Write-Host "Using Claude Code at $env:CLAUDE_BIN" }
else {
  Write-Host 'Claude Code (the command-line tool) was not found. Unusual questions will be skipped, not guessed.' -ForegroundColor Yellow
  Write-Host 'Note: the Claude desktop app is not the same thing. To install Claude Code, run in PowerShell:  irm https://claude.ai/install.ps1 | iex' -ForegroundColor Yellow
}

Step 'Opening Opera'
& powershell -ExecutionPolicy Bypass -File bin\opera.ps1
if ($LASTEXITCODE -ne 0) { Stop-With 'Could not connect to Opera (see the message above).' }
if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'jobagent\opera-profile\.jobright-ok'))) {
  Write-Host "`nFIRST TIME ONLY: in the Opera window that just opened," -ForegroundColor Yellow
  Write-Host '  1. install the JobRight extension from the Chrome Web Store' -ForegroundColor Yellow
  Write-Host '  2. go to jobright.ai and log in' -ForegroundColor Yellow
  Read-Host 'Press Enter here when you are logged in'
  New-Item -ItemType File -Force (Join-Path $env:LOCALAPPDATA 'jobagent\opera-profile\.jobright-ok') | Out-Null
}

Step 'Finding jobs on JobRight (a few minutes)'
node harvest_recommend.mjs
if (-not (Test-Path jr_jobs.json)) { Stop-With 'Could not collect jobs from JobRight (see the message above). Make sure you are logged in to jobright.ai in the agent''s Opera window.' }
Step 'Keeping Canadian jobs only'
node scope.mjs
if (-not (Test-Path jr_jobs_target.json)) { Stop-With 'Could not filter the job list.' }

$env:QUEUE_FILE = 'jr_jobs_target.json'
if ($Submit) { $env:SUBMIT = '1'; Step 'Applying - SUBMITTING for real (leave Opera alone)' }
else { Remove-Item Env:SUBMIT -ErrorAction SilentlyContinue; Step 'Practice run - filling forms, NOT submitting (leave Opera alone)' }
node apply3.mjs 2>&1 | Tee-Object -FilePath apply3.log

# Pass 2: jobs without EASY APPLY, applied to on the company's own site.
# Never at the same time as pass 1 - they share the one Opera window.
Step 'Building the list of jobs to apply to on company websites'
node build_offsite.mjs
$env:QUEUE_FILE = 'offsite_batch.json'
if ($Submit) { Remove-Item Env:LIMIT -ErrorAction SilentlyContinue; Step 'Company websites - SUBMITTING for real (this can take hours; leave Opera alone)' }
else { $env:LIMIT = '5'; Step 'Company websites - practice on 5 jobs, NOT submitting (leave Opera alone)' }
node offsite3.mjs 2>&1 | Tee-Object -FilePath offsite3.log
Step "Done. Logs saved to apply3.log and offsite3.log"
Read-Host 'Press Enter to close'

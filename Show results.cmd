@echo off
cd /d "%~dp0"
node report.mjs
start "" results.html

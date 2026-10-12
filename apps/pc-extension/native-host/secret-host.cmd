@echo off
rem Lyrics Companion - Windows secret store helper (native messaging host).
rem The browser starts this file; it runs secret-host.ps1 for one request (execution policy is relaxed for this process only).
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0secret-host.ps1" %*

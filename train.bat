@echo off
REM Tank Battle - one-click trainer (ASCII only on purpose).
REM cmd.exe parses .bat bytes with the system codepage; Chinese text in a
REM UTF-8 .bat gets mangled into "not recognized as a command". So this file
REM stays ASCII and all Chinese output comes from node (ai\train-cli.js).
chcp 65001 >nul
cd /d "%~dp0"
node ai\train-cli.js %*
pause

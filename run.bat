@echo off
rem kuake-studio 便携版启动器（Windows）
rem 想改端口：run.bat --port 8888
setlocal
cd /d "%~dp0"
start "" "%~dp0kuake-studio.exe" %*

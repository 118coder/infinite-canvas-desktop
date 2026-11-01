@echo off
rem 一键构建桌面版（需要已安装 Bun 和 Go 1.25+）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-desktop.ps1"

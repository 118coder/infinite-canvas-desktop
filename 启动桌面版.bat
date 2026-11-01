@echo off
rem 启动桌面版（如果还没有构建，请先双击"构建桌面版.bat"）
if exist "%~dp0infinite-canvas-desktop.exe" (
    start "" "%~dp0infinite-canvas-desktop.exe"
) else (
    echo 还没有 infinite-canvas-desktop.exe，请先双击"构建桌面版.bat"完成构建。
    pause
)

@echo off
chcp 65001 >nul
echo 正在启动云树笔记 Windows PC 客户端一键打包...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows-pc.ps1" %*
pause

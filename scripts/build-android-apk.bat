@echo off
chcp 65001 >nul
echo 正在启动云树笔记 Android APK 一键构建...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android-apk.ps1"
pause

@echo off
chcp 65001 >nul
echo =========================================
echo   云树笔记 Windows PC 客户端一键打包脚本
echo =========================================
cd /d "%~dp0.."

call npm install
if errorlevel 1 goto :err

call npm run build:shared
if errorlevel 1 goto :err

call npm run build:web
if errorlevel 1 goto :err

where tauri >nul 2>nul
if errorlevel 1 (
  echo 正在安装 @tauri-apps/cli ...
  call npm install -g @tauri-apps/cli
)

cd apps\tauri-app
call tauri build --no-bundle
if errorlevel 1 goto :err

echo.
echo 打包成功！可执行文件：
echo %cd%\src-tauri\target\release\yunshu-desktop.exe
explorer "%cd%\src-tauri\target\release"
pause
exit /b 0

:err
echo [错误] 打包过程中出现异常，请检查上方日志。
pause
exit /b 1

@echo off
chcp 65001 >nul
echo =========================================
echo   云树笔记 Windows 一键启动（SQLite 零依赖版）
echo =========================================
cd /d "%~dp0.."

if not exist ".env" copy ".env.example" ".env" >nul

if not exist "node_modules" (
  echo [1/3] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 goto :err
)

echo [2/3] 编译共享类型包...
call npm run build:shared
if errorlevel 1 goto :err

echo [3/3] 启动 SQLite 服务端与中文 Web 前端...
start "云树笔记-服务端(3001)" cmd /k "npm run dev:server"
timeout /t 2 >nul
start "云树笔记-前端(5173)" cmd /k "npm run dev:web"
timeout /t 3 >nul
start http://localhost:5173
echo 已打开浏览器 http://localhost:5173 ！数据保存在 data\yunshu.db 与 data\files\。
exit /b 0

:err
echo [错误] 启动失败，请检查 Node.js 是否已安装。
pause
exit /b 1

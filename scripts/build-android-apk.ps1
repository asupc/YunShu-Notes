#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  云树笔记 Android APK 一键构建脚本" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

function Check-Command($Name, $Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "[错误] 未检测到 $Name 。$Hint" -ForegroundColor Red
        exit 1
    }
}

Check-Command "node" "请先安装 Node.js 20 LTS: https://nodejs.org/"
Check-Command "rustc" "请先安装 Rust 工具链: https://rustup.rs/"
Check-Command "rustup" "请先安装 Rustup: https://rustup.rs/"

if (-not $env:ANDROID_HOME) {
    Write-Host "[错误] 未配置 ANDROID_HOME 环境变量，请先安装 Android Studio 并设置 Android SDK 路径。" -ForegroundColor Red
    exit 1
}
if (-not $env:NDK_HOME) {
    Write-Host "[错误] 未配置 NDK_HOME 环境变量，请在 Android Studio SDK Manager 中安装 NDK (Side by side)。" -ForegroundColor Red
    exit 1
}

Write-Host "[1/5] 安装 Android Rust 编译目标（aarch64 / armv7）..." -ForegroundColor Green
rustup target add aarch64-linux-android armv7-linux-androideabi

Write-Host "[2/5] 安装前端与工作区依赖..." -ForegroundColor Green
npm install

Write-Host "[3/5] 编译共享包与中文 Web 前端..." -ForegroundColor Green
npm run build:shared
npm run build:web

if (-not (Get-Command "tauri" -ErrorAction SilentlyContinue)) {
    Write-Host "[提示] 正在全局安装 @tauri-apps/cli ..." -ForegroundColor Yellow
    npm install -g @tauri-apps/cli
}

Set-Location "$RootDir\apps\tauri-app"

if (-not (Test-Path "$RootDir\apps\tauri-app\src-tauri\gen\android")) {
    Write-Host "[4/5] 首次初始化 Tauri Android 工程..." -ForegroundColor Green
    tauri android init
} else {
    Write-Host "[4/5] 已检测到 Android 工程，跳过初始化..." -ForegroundColor Green
}

Write-Host "[5/5] 开始构建 Android APK（aarch64）..." -ForegroundColor Green
tauri android build --apk --target aarch64

$ApkDir = "$RootDir\apps\tauri-app\src-tauri\gen\android\app\build\outputs\apk"
Write-Host ""
Write-Host "构建完成！APK 输出目录：" -ForegroundColor Cyan
Write-Host $ApkDir -ForegroundColor Yellow
if (Test-Path $ApkDir) {
    Start-Process explorer.exe $ApkDir
}

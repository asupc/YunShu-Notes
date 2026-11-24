#Requires -Version 5.1
<#
.SYNOPSIS
    云树笔记 Windows 桌面端一键构建（单文件 exe）

.DESCRIPTION
    在宿主机本机构建（需要 Node.js 20+ 与 Rust / MSVC 工具链）：

      1. npm install，构建 packages/shared 与 apps/web
      2. 在 apps/tauri-app 执行 tauri build --no-bundle，产出单文件 exe
      3. 产物默认发布到 SMB 共享 \\192.168.1.71\code；共享不可达时留在
         apps/tauri-app/dist/windows/

    exe 体积由 apps/tauri-app/src-tauri/Cargo.toml 的 [profile.release] 控制
    （strip / LTO / opt-level / panic=abort，参照 terminal-buddy 的发布配置）。

.PARAMETER ReleaseOut
    产物发布目录，默认 \\192.168.1.71\code。
    传空字符串则只保留在本地 dist\windows\，不移动。

.PARAMETER NoInstall
    跳过 npm install（依赖已安装时可加快构建）。

.EXAMPLE
    .\scripts\build-windows-pc.ps1
    构建 exe，命名为 YunShu-Notes_v<版本>_x64.exe 并发布到 \\192.168.1.71\code

.EXAMPLE
    .\scripts\build-windows-pc.ps1 -ReleaseOut ''
    只构建 exe，不发布

.EXAMPLE
    .\scripts\build-windows-pc.ps1 -NoInstall
    跳过 npm install，直接用现有依赖构建
#>
param(
    [string]$ReleaseOut = '\\192.168.1.71\code',
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RootDir     = Split-Path -Parent $PSScriptRoot
$TauriDir    = Join-Path $RootDir 'apps\tauri-app'
$ConfFile    = Join-Path $TauriDir 'src-tauri\tauri.conf.json'
$ExePath     = Join-Path $TauriDir 'src-tauri\target\release\yunshu-desktop.exe'
$DistDir     = Join-Path $TauriDir 'dist\windows'
$Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "警告：$Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
    Write-Host "[错误] $Message" -ForegroundColor Red
    exit 1
}

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  云树笔记 Windows PC 客户端一键打包' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail '未检测到 Node.js，请先安装 Node.js 20+。'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail '未检测到 npm，请先安装 Node.js 20+。'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Fail '未检测到 cargo，请先安装 Rust（https://rustup.rs/）。'
}
if (-not (Test-Path $ConfFile)) {
    Fail "文件不存在：$ConfFile"
}

$version = (Get-Content -LiteralPath $ConfFile -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $version) { Fail "未在 $ConfFile 中找到 version 字段" }

# ---------------------------------------------------------------------------
# 前端依赖与构建
# ---------------------------------------------------------------------------
Push-Location $RootDir
try {
    if (-not $NoInstall) {
        Write-Step '安装前端依赖（npm install）'
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail 'npm install 失败' }
    }

    Write-Step '构建共享包与 Web 前端'
    & npm run build:shared
    if ($LASTEXITCODE -ne 0) { Fail 'build:shared 失败' }
    & npm run build:web
    if ($LASTEXITCODE -ne 0) { Fail 'build:web 失败' }

    if (-not (Get-Command tauri -ErrorAction SilentlyContinue)) {
        Write-Step '安装 @tauri-apps/cli'
        & npm install -g @tauri-apps/cli
        if ($LASTEXITCODE -ne 0) { Fail '安装 @tauri-apps/cli 失败' }
    }

    # -----------------------------------------------------------------------
    # Tauri 构建（--no-bundle：只出单文件 exe）
    # -----------------------------------------------------------------------
    Write-Step "构建 exe（版本 $version，release 体积优化已开启）"
    Push-Location $TauriDir
    try {
        & tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { Fail 'tauri build 失败' }
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $ExePath)) {
    Fail "构建结束但未找到 exe：$ExePath"
}
$exeSizeMb = [Math]::Round((Get-Item -LiteralPath $ExePath).Length / 1MB, 2)
Write-Step "exe 构建完成：$ExePath（$exeSizeMb MB）"

# ---------------------------------------------------------------------------
# 归档：exe 复制到 dist（参照 terminal-buddy 的版本化产物命名）
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

$baseName = "YunShu-Notes_v${version}_x64"
$distExe  = Join-Path $DistDir "$baseName.exe"
Copy-Item -LiteralPath $ExePath -Destination $distExe -Force
Write-Step "exe 已复制：$distExe"

$published = @($distExe)

# ---------------------------------------------------------------------------
# 发布到 SMB 共享（不可达时保留本地）
# ---------------------------------------------------------------------------
$shareAvailable = $false
if ($ReleaseOut) {
    try { $shareAvailable = Test-Path -LiteralPath $ReleaseOut } catch { $shareAvailable = $false }
    if (-not $shareAvailable) {
        Write-Warn "发布目录不可达：$ReleaseOut，产物保留在 $DistDir"
    }
}

$finalPaths = @()
if ($shareAvailable) {
    foreach ($file in $published) {
        $target = Join-Path $ReleaseOut (Split-Path -Leaf $file)
        try {
            Move-Item -LiteralPath $file -Destination $target -Force
            $finalPaths += $target
        } catch {
            Write-Warn "移动到 $ReleaseOut 失败：$($_.Exception.Message)，产物保留在本地"
            $shareAvailable = $false
        }
    }
}
if (-not $shareAvailable) {
    foreach ($file in $published) {
        if (Test-Path -LiteralPath $file) { $finalPaths += $file }
    }
}

$openDir = if ($shareAvailable) { $ReleaseOut } else { $DistDir }
Write-Host ''
Write-Host '构建完成！' -ForegroundColor Cyan
Write-Host "版本：$version（Windows x64）" -ForegroundColor Yellow
if ($shareAvailable) {
    Write-Host "产物已移动到：$ReleaseOut" -ForegroundColor Green
} else {
    Write-Host "产物保留在本地：$DistDir" -ForegroundColor Yellow
}
$finalPaths | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Green }

Start-Process explorer.exe $openDir

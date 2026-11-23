#Requires -Version 5.1
<#
.SYNOPSIS
    云树笔记 Android APK 容器构建脚本（Windows / Docker Desktop 版）

.DESCRIPTION
    宿主机只需安装 Docker Desktop，Rust / Node.js / JDK / Android SDK / NDK 全部在
    一次性 Linux 容器内准备，耗时的下载与编译产物缓存在 docker named volume 中：

      JDK          : eclipse-temurin:17-jdk（AGP 9.3 / Gradle 9.6 要求 JDK 17+）
      Node.js      : v20.20.2，安装到 yunshu-node 卷
      Rust         : rustup stable + 4 个 Android target，缓存在 yunshu-cargo-home /
                     yunshu-rustup-home 卷
      Android SDK  : cmdline-tools / platform-37.0 / build-tools-36.0.0 / NDK 29，
                     缓存在 yunshu-android-sdk 卷（首次约 1.5GB）
      Gradle       : 发行包与依赖缓存在 yunshu-gradle-cache 卷
      cargo 产物   : yunshu-cargo-target 卷（Rust 增量编译）
      npm 缓存     : yunshu-npm-cache 卷

    默认构建「已签名」的 release APK：
      - 首次运行自动用 keytool 生成自签名证书
        apps/tauri-app/keystore/yunshu-release.jks，密码记录在同目录
        keystore.properties（该目录已加入 .gitignore，请自行备份，
        丢失后将无法覆盖安装旧版本）
      - 每次 release 构建自动把 tauri.conf.json / Cargo.toml 的补丁号 +1，
        Tauri 会据此生成递增的 Android versionCode
      - 产物先复制到 apps/tauri-app/dist/android/，命名为
        YunShu-Notes-v<版本>-<ABI>.apk，并在容器内用 apksigner 校验签名；
        构建成功后移动到 SMB 共享 \\192.168.1.71\code（可用 -ReleaseOut 修改，
        共享不可达时自动保留在 dist/android/ 并给出警告）

    国内网络默认使用镜像（腾讯云 Android SDK / Gradle、阿里云 Maven、
    npmmirror、rsproxy），失败时自动回退官方源；可用 -NoMirror 全部关闭。

    release 包默认开启 APK 体积优化（关联 src-tauri/Cargo.toml 的 [profile.release]）：
      - Rust 端 strip 符号表 + LTO + opt-level="s" + panic="abort"，
        并裁剪 tokio / reqwest / zip 未使用的特性
      - Gradle 端 useLegacyPackaging 压缩 APK 内的 .so（原生库约占包体 85%，
        压缩后体积减半以上），语言资源只保留 zh / en
      - 传 -NoSoCompress 可只关闭 .so 压缩（安装后占用更小、启动略快，但 APK 更大）

.PARAMETER DebugBuild
    构建 debug APK（不递增版本号、不生成签名证书）。

.PARAMETER NoVersionBump
    release 构建时也保持版本号不变。

.PARAMETER RefreshDeps
    构建前删除 Gradle / cargo target / npm 缓存卷，强制重新下载依赖
    （不会删除 SDK、Rust 工具链等大体积卷）。

.PARAMETER NewKeystore
    删除已有 release 证书并重新生成。注意：新证书签名的 APK 无法覆盖安装旧版本。

.PARAMETER NoMirror
    不使用国内镜像，全部走官方源。

.PARAMETER NoSoCompress
    不压缩 APK 内的 .so（默认压缩，APK 更小但安装时会解压到应用目录；
    关闭后 APK 更大、安装后占用更小、启动略快）。

.PARAMETER JdkImage
    JDK 容器镜像，默认 eclipse-temurin:17-jdk。

.PARAMETER TauriCliVersion
    @tauri-apps/cli 版本，默认 2.12.6（与 Cargo.lock 中的 tauri 2.12.x 匹配）。

.PARAMETER AndroidTarget
    Rust / Android 架构：aarch64（默认，真机）/ armv7 / x86_64 / i686。

.PARAMETER Cpus / Memory
    容器 CPU 上限（默认 4）与内存上限（如 3g，默认不限制）。

.PARAMETER DistDir
    构建产物的本地暂存目录，默认 apps/tauri-app/dist/android。

.PARAMETER ReleaseOut
    APK 最终发布目录（SMB 共享），默认 \\192.168.1.71\code。
    构建成功后 APK 会从 DistDir 移动到这里；共享不可达时保留在 DistDir。
    传空字符串则只保留本地，不移动。

.EXAMPLE
    .\scripts\build-android-apk.ps1
    构建已签名 release APK，版本号自增，产物移动到 \\192.168.1.71\code

.EXAMPLE
    .\scripts\build-android-apk.ps1 -ReleaseOut 'D:\apk-out'
    构建 release APK 并移动到指定本地目录

.EXAMPLE
    .\scripts\build-android-apk.ps1 -DebugBuild
    构建 debug APK，不动版本号

.EXAMPLE
    .\scripts\build-android-apk.ps1 -RefreshDeps -NoMirror
    清空依赖缓存并全部走官方源重新构建
#>
param(
    [switch]$DebugBuild,
    [switch]$NoVersionBump,
    [switch]$RefreshDeps,
    [switch]$NewKeystore,
    [switch]$NoMirror,
    [switch]$NoSoCompress,
    [string]$JdkImage = 'eclipse-temurin:17-jdk',
    [string]$TauriCliVersion = '2.12.6',
    [string]$AndroidTarget = 'aarch64',
    [int]$Cpus = 4,
    [string]$Memory = '',
    [string]$DistDir = '',
    [string]$ReleaseOut = '\\192.168.1.71\code'
)

$ErrorActionPreference = 'Stop'
# 容器输出是 UTF-8，中文日志在 PowerShell 控制台需要显式设置
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------
$RootDir     = Split-Path -Parent $PSScriptRoot
$TauriDir    = Join-Path $RootDir 'apps\tauri-app'
$SrcTauriDir = Join-Path $TauriDir 'src-tauri'
$ConfFile    = Join-Path $SrcTauriDir 'tauri.conf.json'
$CargoFile   = Join-Path $SrcTauriDir 'Cargo.toml'
$KeystoreDir = Join-Path $TauriDir 'keystore'
$Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)

$SdkVolume         = 'yunshu-android-sdk'
$GradleVolume      = 'yunshu-gradle-cache'
$NodeVolume        = 'yunshu-node'
$NpmCacheVolume    = 'yunshu-npm-cache'
$CargoHomeVolume   = 'yunshu-cargo-home'
$RustupVolume      = 'yunshu-rustup-home'
$CargoTargetVolume = 'yunshu-cargo-target'
$AptListsVolume    = 'yunshu-apt-lists'
$AptCacheVolume    = 'yunshu-apt-cache'

$NodeVersion        = 'v20.20.2'
$CmdlineToolsUrl    = 'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip'

if (-not $DistDir) { $DistDir = Join-Path $TauriDir 'dist\android' }

$validTargets = @('aarch64', 'armv7', 'x86_64', 'i686')
if ($validTargets -notcontains $AndroidTarget) {
    Write-Host "[错误] -AndroidTarget 只支持：$($validTargets -join ' / ')" -ForegroundColor Red
    exit 1
}
$AbiName = @{ aarch64 = 'arm64-v8a'; armv7 = 'armeabi-v7a'; x86_64 = 'x86_64'; i686 = 'x86' }[$AndroidTarget]

$isDebug = [bool]$DebugBuild
$isRelease = -not $isDebug
$BuildKind = if ($isDebug) { 'debug' } else { 'release' }
# 压缩 APK 内的 .so（useLegacyPackaging），可显著减小下载/传输体积
$LegacyPackaging = if ($NoSoCompress) { '0' } else { '1' }

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "警告：$Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
    Write-Host "[错误] $Message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 环境检查
# ---------------------------------------------------------------------------
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  云树笔记 Android APK 容器构建（Docker）' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail '未检测到 docker 命令，请先安装并启动 Docker Desktop。'
}
& docker version --format '{{.Server.Version}}' *> $null
if ($LASTEXITCODE -ne 0) {
    Fail 'Docker 守护进程不可用，请先启动 Docker Desktop。'
}

foreach ($f in @($ConfFile, $CargoFile)) {
    if (-not (Test-Path $f)) { Fail "文件不存在：$f" }
}

# ---------------------------------------------------------------------------
# 国内镜像（失败时容器脚本会回退官方源）
# ---------------------------------------------------------------------------
if ($NoMirror) {
    $CmdlineToolsMirror = ''
    $SdkMirror          = ''
    $GradleDistMirror   = ''
    $NodeDistMirror     = ''
    $NpmRegistry        = ''
    $CargoMirror        = ''
    $MavenMirror        = ''
} else {
    $CmdlineToolsMirror = 'https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-linux-11076708_latest.zip'
    $SdkMirror          = 'https://mirrors.cloud.tencent.com/AndroidSDK/'
    $GradleDistMirror   = 'https://mirrors.cloud.tencent.com/gradle'
    $NodeDistMirror     = 'https://npmmirror.com/mirrors/node'
    $NpmRegistry        = 'https://registry.npmmirror.com'
    $CargoMirror        = 'https://rsproxy.cn'
    $MavenMirror        = '1'
}

# ---------------------------------------------------------------------------
# 版本号自增（tauri.conf.json + Cargo.toml）
# ---------------------------------------------------------------------------
$confText = [System.IO.File]::ReadAllText($ConfFile, [System.Text.Encoding]::UTF8)
$versionMatch = [regex]::Match($confText, '(?m)^(\s*"version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")')
if (-not $versionMatch.Success) {
    Fail "未在 $ConfFile 中找到 version 字段"
}
$currentVersion = '{0}.{1}.{2}' -f $versionMatch.Groups[2].Value, $versionMatch.Groups[3].Value, $versionMatch.Groups[4].Value
$buildVersion = $currentVersion

if ($isRelease -and -not $NoVersionBump) {
    $patch = [int]$versionMatch.Groups[4].Value + 1
    $buildVersion = '{0}.{1}.{2}' -f $versionMatch.Groups[2].Value, $versionMatch.Groups[3].Value, $patch

    $confText = $confText.Remove($versionMatch.Groups[4].Index, $versionMatch.Groups[4].Length).
                             Insert($versionMatch.Groups[4].Index, [string]$patch)
    [System.IO.File]::WriteAllText($ConfFile, $confText, $Utf8NoBom)

    $cargoText = [System.IO.File]::ReadAllText($CargoFile, [System.Text.Encoding]::UTF8)
    $cargoVer = [regex]::Match($cargoText, '(?m)^(version\s*=\s*")\d+\.\d+\.\d+(")')
    if ($cargoVer.Success) {
        $replacement = $cargoVer.Groups[1].Value + $buildVersion + $cargoVer.Groups[2].Value
        $cargoText = $cargoText.Remove($cargoVer.Index, $cargoVer.Length).Insert($cargoVer.Index, $replacement)
        [System.IO.File]::WriteAllText($CargoFile, $cargoText, $Utf8NoBom)
    } else {
        Write-Warn "未在 $CargoFile 中找到版本号，仅更新了 tauri.conf.json"
    }

    Write-Step "版本号自增：$currentVersion -> $buildVersion（tauri.conf.json / Cargo.toml）"
} else {
    Write-Host "版本号保持不变：$buildVersion" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# release 签名证书（首次自动生成）
# ---------------------------------------------------------------------------
$KeystoreAlias    = 'yunshu'
$KeystorePassword = 'yunshu-release-2026'
$KeystoreFileName = 'yunshu-release.jks'

if (-not (Test-Path $KeystoreDir)) {
    New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
}
$KeystorePropsFile = Join-Path $KeystoreDir 'keystore.properties'
$KeystoreFile      = Join-Path $KeystoreDir $KeystoreFileName

if (Test-Path $KeystorePropsFile) {
    $propsText = [System.IO.File]::ReadAllText($KeystorePropsFile, [System.Text.Encoding]::UTF8)
    $aliasMatch = [regex]::Match($propsText, '(?m)^\s*keyAlias\s*=\s*(.+?)\s*$')
    if ($aliasMatch.Success) { $KeystoreAlias = $aliasMatch.Groups[1].Value.Trim() }
    $pwMatch = [regex]::Match($propsText, '(?m)^\s*password\s*=\s*(.+?)\s*$')
    if (-not $pwMatch.Success) {
        $pwMatch = [regex]::Match($propsText, '(?m)^\s*storePassword\s*=\s*(.+?)\s*$')
    }
    if ($pwMatch.Success) { $KeystorePassword = $pwMatch.Groups[1].Value.Trim() }
    $storeMatch = [regex]::Match($propsText, '(?m)^\s*storeFile\s*=\s*(.+?)\s*$')
    if ($storeMatch.Success) {
        $KeystoreFileName = Split-Path -Leaf $storeMatch.Groups[1].Value.Trim()
        $KeystoreFile = Join-Path $KeystoreDir $KeystoreFileName
    }
} else {
    $propsContent = @(
        "storeFile=$KeystoreFileName"
        "keyAlias=$KeystoreAlias"
        "password=$KeystorePassword"
        "storePassword=$KeystorePassword"
        ''
    ) -join "`n"
    [System.IO.File]::WriteAllText($KeystorePropsFile, $propsContent, $Utf8NoBom)
    Write-Step "已生成签名配置：$KeystorePropsFile"
}

if ($NewKeystore -and (Test-Path $KeystoreFile)) {
    Remove-Item -Force $KeystoreFile
    Write-Warn '已删除旧证书，本次将重新生成（旧版本 APK 将无法覆盖安装）'
}

if ($isRelease -and (Test-Path $KeystoreFile)) {
    Write-Host "使用签名证书：$KeystoreFile" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 缓存卷
# ---------------------------------------------------------------------------
if ($RefreshDeps) {
    Write-Step '清理 Gradle / cargo target / npm 缓存卷'
    foreach ($v in @($GradleVolume, $CargoTargetVolume, $NpmCacheVolume)) {
        & docker volume rm $v 2>&1 | Out-Null
    }
}

foreach ($v in @($SdkVolume, $GradleVolume, $NodeVolume, $NpmCacheVolume, $CargoHomeVolume, $RustupVolume, $CargoTargetVolume, $AptListsVolume, $AptCacheVolume)) {
    & docker volume create $v 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "创建 docker 卷失败：$v" }
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
# 清掉上一次的构建输出，避免脚本误报旧 APK
$outputsDir = Join-Path $DistDir 'outputs'
if (Test-Path $outputsDir) { Remove-Item -Recurse -Force $outputsDir }

$stageDir = Join-Path $env:TEMP ('yunshu-android-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

# ---------------------------------------------------------------------------
# 容器内构建脚本（LF 换行写入临时目录，避免 PowerShell 向 bash 传多行参数）
# ---------------------------------------------------------------------------
$containerScript = @'
set -eu

log() { echo "==> $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

export PATH="/opt/node/bin:/opt/cargo/bin:${PATH}"
export DEBIAN_FRONTEND=noninteractive
export RUSTUP_HOME="${RUSTUP_HOME:-/opt/rustup}"
export CARGO_HOME="${CARGO_HOME:-/opt/cargo}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/gradle-cache}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/npm-cache}"

if [ -n "${NPM_REGISTRY:-}" ]; then
    export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
fi
if [ -n "${CARGO_MIRROR:-}" ]; then
    export RUSTUP_DIST_SERVER="$CARGO_MIRROR"
    export RUSTUP_UPDATE_ROOT="$CARGO_MIRROR/rustup"
fi

if ! have unzip || ! have cc || ! have pkg-config; then
    log "安装构建工具（unzip / gcc / make / pkg-config）"
    mkdir -p /var/cache/apt/archives/partial
    chown -R _apt:root /var/cache/apt/archives 2>/dev/null || true
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends unzip build-essential pkg-config >/dev/null
fi

# ------------------------------ Node.js ------------------------------
if [ ! -x /opt/node/bin/node ]; then
    log "安装 Node.js ${NODE_VERSION}"
    got=""
    for u in "${NODE_DIST_MIRROR:-}/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" \
             "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz"; do
        [ -n "$u" ] || continue
        case "$u" in /*) continue ;; esac
        if curl -fsSL --connect-timeout 20 -o /tmp/node.tar.gz "$u"; then got=1; break; fi
        log "Node.js 下载失败，换源重试"
    done
    [ -n "$got" ] || { echo "错误：Node.js 所有源均下载失败" >&2; exit 1; }
    mkdir -p /opt/node
    tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1
fi
export PATH="/opt/node/bin:$PATH"
node --version

# ------------------------------ Rust ------------------------------
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    log "安装 Rust 工具链（rustup，首次约 200MB）"
    curl -fsSL --connect-timeout 20 -o /tmp/rustup-init.sh https://sh.rustup.rs
    if ! sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable --no-modify-path; then
        log "镜像源安装失败，回退官方源"
        unset RUSTUP_DIST_SERVER RUSTUP_UPDATE_ROOT || true
        sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable --no-modify-path
    fi
fi
export PATH="$CARGO_HOME/bin:$PATH"
cargo --version

mkdir -p "$CARGO_HOME"
if [ -n "${CARGO_MIRROR:-}" ]; then
cat > "$CARGO_HOME/config.toml" <<'EOF'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
EOF
else
    rm -f "$CARGO_HOME/config.toml"
fi

if ! rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android; then
    log "Rust target 下载失败，回退官方源"
    unset RUSTUP_DIST_SERVER RUSTUP_UPDATE_ROOT || true
    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
fi

# ------------------------------ Android SDK ------------------------------
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
    log "下载 Android cmdline-tools"
    got=""
    for u in "${CMDLINE_TOOLS_MIRROR:-}" "${CMDLINE_TOOLS_URL:-}"; do
        [ -n "$u" ] || continue
        if curl -fsSL --connect-timeout 20 -o /tmp/cmdline-tools.zip "$u"; then got=1; break; fi
        log "cmdline-tools 下载失败，换源重试：$u"
    done
    [ -n "$got" ] || { echo "错误：cmdline-tools 所有源均下载失败" >&2; exit 1; }
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    rm -rf "$ANDROID_HOME/cmdline-tools/cmdline-tools"
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"
    if [ -d "$ANDROID_HOME/cmdline-tools/cmdline-tools" ]; then
        rm -rf "$ANDROID_HOME/cmdline-tools/latest"
        mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    fi
fi
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true

sdk_install() {
    if [ -n "${SDK_TEST_BASE_URL:-}" ]; then
        if yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "$@" >/dev/null 2>&1; then
            return 0
        fi
        log "镜像源安装 SDK 组件失败，回退官方源"
        unset SDK_TEST_BASE_URL || true
    fi
    yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "$@" >/dev/null 2>&1
}

need_sdk=0
if [ ! -d "$ANDROID_HOME/platforms/android-37.0" ] && [ ! -d "$ANDROID_HOME/platforms/android-37" ]; then need_sdk=1; fi
if [ ! -d "$ANDROID_HOME/build-tools/36.0.0" ]; then need_sdk=1; fi
if [ ! -d "$ANDROID_HOME/ndk/29.0.13846066" ]; then need_sdk=1; fi
if [ ! -d "$ANDROID_HOME/platform-tools" ]; then need_sdk=1; fi
if [ "$need_sdk" = "1" ]; then
    log "安装 Android SDK 组件（platform-37.0 / build-tools-36.0.0 / NDK 29，首次约 1.5GB）"
    sdk_install 'platform-tools' 'platforms;android-37.0' 'build-tools;36.0.0' 'ndk;29.0.13846066' \
        || log "警告：部分 SDK 组件安装失败，交由 AGP 按需下载"
fi
NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$NDK_HOME" ]; then
    export NDK_HOME
    log "使用 NDK：$NDK_HOME"
fi

# ------------------------------ 复制源码 ------------------------------
log "复制源码到容器内 /tmp/app"
rm -rf /tmp/app
mkdir -p /tmp/app /cargo-target
cd /src
tar -cf - \
    --exclude=./.git \
    --exclude=./node_modules \
    --exclude=./apps/tauri-app/src-tauri/target \
    --exclude=./apps/tauri-app/src-tauri/gen \
    --exclude=./apps/tauri-app/dist \
    --exclude=./apps/web/dist \
    --exclude=./packages/shared/dist \
    --exclude=./data \
    . | tar -xf - -C /tmp/app
cd /tmp/app
ln -sfn /cargo-target apps/tauri-app/src-tauri/target

# ------------------------------ 前端依赖与 Tauri CLI ------------------------------
log "安装前端依赖（npm install，跳过原生模块编译脚本）"
npm install --ignore-scripts --no-audit --no-fund

if ! tauri --version 2>/dev/null | grep -q "$TAURI_CLI_VERSION"; then
    log "安装 @tauri-apps/cli@$TAURI_CLI_VERSION"
    npm install -g "@tauri-apps/cli@$TAURI_CLI_VERSION" --no-audit --no-fund || \
        npm install -g "@tauri-apps/cli@$TAURI_CLI_VERSION" --registry=https://registry.npmjs.org --no-audit --no-fund
fi
tauri --version

# @tauri-apps/cli 是 Node 原生插件：tauri android build 生成的 Gradle 任务会以
# `node <src-tauri>/tauri android android-studio-script ...` 形式回调 CLI。
# 项目没有本地 node_modules，这里放一个指向全局 CLI 的软链接作为入口。
TAURI_CLI_JS="$(npm root -g)/@tauri-apps/cli/tauri.js"
if [ -f "$TAURI_CLI_JS" ]; then
    ln -sfn "$TAURI_CLI_JS" /tmp/app/apps/tauri-app/src-tauri/tauri
fi

# ------------------------------ 生成签名证书 ------------------------------
if [ "$BUILD_KIND" = "release" ] && [ ! -f "/keystore-out/$KEYSTORE_FILE_NAME" ]; then
    log "生成 release 签名证书 /keystore-out/$KEYSTORE_FILE_NAME"
    keytool -genkeypair \
        -keystore "/keystore-out/$KEYSTORE_FILE_NAME" \
        -alias "$KEYSTORE_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
        -dname "CN=YunShu Notes, OU=Mobile, O=YunShu, L=Beijing, ST=Beijing, C=CN"
fi

# ------------------------------ 初始化 Android 工程 ------------------------------
cd /tmp/app/apps/tauri-app
if [ ! -d src-tauri/gen/android ]; then
    log "初始化 Tauri Android 工程"
    tauri android init --ci --skip-targets-install
fi

if [ -f /tmp/app/apps/tauri-app/logo-source-1024.png ]; then
    log "同步与 PC 端一致的云树笔记应用图标到 Android 工程"
    tauri icon /tmp/app/apps/tauri-app/logo-source-1024.png
    BG_XML="src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml"
    if [ -f "$BG_XML" ]; then
        sed -i 's|<color name="ic_launcher_background">[^<]*</color>|<color name="ic_launcher_background">#000000</color>|g' "$BG_XML"
    fi
fi

if [ "$BUILD_KIND" = "release" ]; then
    if [ -f /keystore-out/keystore.properties ]; then
        cp /keystore-out/keystore.properties src-tauri/gen/android/keystore.properties
    fi
    if [ -f "/keystore-out/$KEYSTORE_FILE_NAME" ]; then
        cp "/keystore-out/$KEYSTORE_FILE_NAME" "src-tauri/gen/android/app/$KEYSTORE_FILE_NAME"
    fi
    GRADLE_APP_FILE=src-tauri/gen/android/app/build.gradle.kts \
    GRADLE_ROOT_FILE=src-tauri/gen/android/build.gradle.kts \
    MAVEN_MIRROR="$MAVEN_MIRROR" \
    node /tmp/patch-gradle.js
fi

# ------------------------------ Gradle 镜像 ------------------------------
GW=src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties
if [ -n "${GRADLE_DIST_MIRROR:-}" ] && [ -f "$GW" ]; then
    dist_file=$(grep -E '^distributionUrl=' "$GW" | head -1 | sed 's|.*/||' | tr -d '\r')
    if [ -n "$dist_file" ] && curl -fsIL --connect-timeout 10 "$GRADLE_DIST_MIRROR/$dist_file" >/dev/null 2>&1; then
        sed -i "s|^distributionUrl=.*|distributionUrl=$GRADLE_DIST_MIRROR/$dist_file|" "$GW"
        log "Gradle 发行包使用镜像：$GRADLE_DIST_MIRROR/$dist_file"
    fi
fi
if [ "$MAVEN_MIRROR" = "1" ]; then
    mkdir -p "$GRADLE_USER_HOME/init.d"
    cat > "$GRADLE_USER_HOME/init.d/yunshu-mirrors.gradle" <<'EOF'
gradle.projectsLoaded {
    gradle.rootProject.allprojects { p ->
        p.buildscript.repositories {
            maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
            maven { url 'https://maven.aliyun.com/repository/google' }
            maven { url 'https://maven.aliyun.com/repository/public' }
        }
        p.repositories {
            maven { url 'https://maven.aliyun.com/repository/google' }
            maven { url 'https://maven.aliyun.com/repository/public' }
            maven { url 'https://maven.aliyun.com/repository/central' }
        }
    }
}
EOF
else
    rm -f "$GRADLE_USER_HOME/init.d/yunshu-mirrors.gradle"
fi

# ------------------------------ 构建 ------------------------------
log "开始构建 Android $BUILD_KIND APK（target: $ANDROID_TARGET）"
if [ "$BUILD_KIND" = "debug" ]; then
    tauri android build --debug --apk --target "$ANDROID_TARGET" --ci --ignore-version-mismatches
else
    tauri android build --apk --target "$ANDROID_TARGET" --ci --ignore-version-mismatches
fi

APK_ROOT=src-tauri/gen/android/app/build/outputs/apk
if [ "$BUILD_KIND" = "release" ]; then
    APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
    if [ -z "$APKSIGNER" ]; then
        echo "错误：未找到 apksigner，无法校验 release 签名" >&2
        exit 1
    fi
    apk_list="$(find "$APK_ROOT" -path '*release*' -name '*.apk' 2>/dev/null || true)"
    if [ -z "$apk_list" ]; then
        echo "错误：未找到 release APK" >&2
        exit 1
    fi
    for apk in $apk_list; do
        log "校验签名：$apk"
        if ! "$APKSIGNER" verify --print-certs "$apk" >/dev/null 2>&1; then
            echo "错误：$apk 签名校验失败（未签名或签名损坏），终止构建" >&2
            exit 1
        fi
    done
fi

log "复制构建产物到 /out/outputs"
mkdir -p /out/outputs
rm -rf /out/outputs/*
cp -a "$APK_ROOT/." /out/outputs/
'@

$containerScriptPath = Join-Path $stageDir 'build-container.sh'
[System.IO.File]::WriteAllText($containerScriptPath, ($containerScript -replace "`r`n", "`n"), $Utf8NoBom)

# ---------------------------------------------------------------------------
# Android Gradle 补丁脚本：注入 release 签名 + APK 体积优化 + Maven 镜像
# ---------------------------------------------------------------------------
$patchScript = @'
const fs = require('fs');

function patchAppGradle(file) {
    let src = fs.readFileSync(file, 'utf8');
    if (src.indexOf('\nandroid {') === -1) {
        console.error('错误：未找到 android 代码块：' + file);
        process.exit(1);
    }

    // ---- release 签名 ----
    if (src.indexOf('yunshuSigningApplied') === -1) {
    const decl = [
        '',
        '// yunshuSigningApplied: 由构建脚本注入的 release 签名配置',
        'val yunshuKeystoreProperties = Properties().apply {',
        '    val propFile = rootProject.file("keystore.properties")',
        '    if (propFile.exists()) {',
        '        propFile.inputStream().use { load(it) }',
        '    }',
        '}',
        'val yunshuHasReleaseKeystore = rootProject.file("keystore.properties").exists()',
        ''
    ].join('\n');
    src = src.replace('\nandroid {', decl + '\nandroid {');

    const signing = [
        '',
        '    signingConfigs {',
        '        if (yunshuHasReleaseKeystore) {',
        '            create("release") {',
        '                keyAlias = yunshuKeystoreProperties["keyAlias"] as String',
        '                keyPassword = yunshuKeystoreProperties["password"] as String',
        '                storeFile = file(yunshuKeystoreProperties["storeFile"] as String)',
        '                storePassword = yunshuKeystoreProperties["password"] as String',
        '            }',
        '        }',
        '    }'
    ].join('\n');
    src = src.replace('android {', 'android {' + signing);

    const marker = 'getByName("release") {';
    const idx = src.indexOf(marker);
    if (idx === -1) {
        console.error('错误：未找到 release 构建类型：' + file);
        process.exit(1);
    }
    const insertAt = idx + marker.length;
    const rel = '\n            if (yunshuHasReleaseKeystore) {\n' +
                '                signingConfig = signingConfigs.getByName("release")\n' +
                '            }';
    src = src.slice(0, insertAt) + rel + src.slice(insertAt);

        console.log('==> 已注入 release 签名配置：' + file);
    }

    // ---- APK 体积优化 ----
    if (src.indexOf('yunshuSizeOptimized') === -1) {
        // Tauri 默认把 .so 不压缩地放进 APK（minSdk>=23 且未设 useLegacyPackaging）。
        // 原生库约占包体 85%，压缩后传输体积可减半以上；代价是安装时解压到应用目录。
        // 用 -NoSoCompress 可跳过这一步。
        if (process.env.LEGACY_PACKAGING === '1' &&
            src.indexOf('useLegacyPackaging = true') === -1) {
            const packaging = [
                '',
                '    // yunshuSizeOptimized: 压缩 APK 内的原生库',
                '    packaging {',
                '        jniLibs {',
                '            useLegacyPackaging = true',
                '        }',
                '    }'
            ].join('\n');
            src = src.replace('\nandroid {', '\nandroid {' + packaging);
        }

        // appcompat / material / webkit 等依赖自带几十套本地化资源，
        // 应用界面固定为中文，只保留中英文资源即可。
        if (src.indexOf('resourceConfigurations') === -1 &&
            src.indexOf('defaultConfig {') !== -1) {
            src = src.replace('defaultConfig {',
                'defaultConfig {\n' +
                '        // yunshuSizeOptimized: 只保留中英文资源\n' +
                '        resourceConfigurations += listOf("zh", "en")');
        }

        console.log('==> 已注入 APK 体积优化配置：' + file);
    }

    fs.writeFileSync(file, src);
}

function patchRootGradle(file) {
    if (process.env.MAVEN_MIRROR !== '1') return;
    let src = fs.readFileSync(file, 'utf8');
    if (src.indexOf('maven.aliyun.com') !== -1) return;
    src = src.replace(/^([ \t]*)google\(\)$/gm,
        '$1maven { url = uri("https://maven.aliyun.com/repository/google") }\n$1google()');
    src = src.replace(/^([ \t]*)mavenCentral\(\)$/gm,
        '$1maven { url = uri("https://maven.aliyun.com/repository/public") }\n$1mavenCentral()');
    fs.writeFileSync(file, src);
    console.log('==> 已注入 Maven 镜像仓库：' + file);
}

const appFile = process.env.GRADLE_APP_FILE;
const rootFile = process.env.GRADLE_ROOT_FILE;
if (appFile) patchAppGradle(appFile);
if (rootFile && fs.existsSync(rootFile)) patchRootGradle(rootFile);
'@

$patchScriptPath = Join-Path $stageDir 'patch-gradle.js'
[System.IO.File]::WriteAllText($patchScriptPath, ($patchScript -replace "`r`n", "`n"), $Utf8NoBom)

# ---------------------------------------------------------------------------
# 运行容器
# ---------------------------------------------------------------------------
$dockerArgs = @(
    'run', '--rm',
    '--cpus', "$Cpus"
)
if ($Memory) { $dockerArgs += @('--memory', $Memory) }
$dockerArgs += @(
    '--mount', "type=bind,source=$RootDir,target=/src,readonly",
    '--mount', "type=bind,source=$DistDir,target=/out",
    '--mount', "type=bind,source=$KeystoreDir,target=/keystore-out",
    '--mount', "type=bind,source=$containerScriptPath,target=/tmp/build-container.sh,readonly",
    '--mount', "type=bind,source=$patchScriptPath,target=/tmp/patch-gradle.js,readonly",
    '--mount', "type=volume,source=$SdkVolume,target=/opt/android-sdk",
    '--mount', "type=volume,source=$GradleVolume,target=/gradle-cache",
    '--mount', "type=volume,source=$NodeVolume,target=/opt/node",
    '--mount', "type=volume,source=$NpmCacheVolume,target=/npm-cache",
    '--mount', "type=volume,source=$CargoHomeVolume,target=/opt/cargo",
    '--mount', "type=volume,source=$RustupVolume,target=/opt/rustup",
    '--mount', "type=volume,source=$CargoTargetVolume,target=/cargo-target",
    '--mount', "type=volume,source=$AptListsVolume,target=/var/lib/apt/lists",
    '--mount', "type=volume,source=$AptCacheVolume,target=/var/cache/apt/archives",
    '-e', 'ANDROID_HOME=/opt/android-sdk',
    '-e', 'GRADLE_USER_HOME=/gradle-cache',
    '-e', 'NPM_CONFIG_CACHE=/npm-cache',
    '-e', "BUILD_KIND=$BuildKind",
    '-e', "ANDROID_TARGET=$AndroidTarget",
    '-e', "TAURI_CLI_VERSION=$TauriCliVersion",
    '-e', "NODE_VERSION=$NodeVersion",
    '-e', "NODE_DIST_MIRROR=$NodeDistMirror",
    '-e', "NPM_REGISTRY=$NpmRegistry",
    '-e', "CARGO_MIRROR=$CargoMirror",
    '-e', "CMDLINE_TOOLS_MIRROR=$CmdlineToolsMirror",
    '-e', "CMDLINE_TOOLS_URL=$CmdlineToolsUrl",
    '-e', "SDK_TEST_BASE_URL=$SdkMirror",
    '-e', "GRADLE_DIST_MIRROR=$GradleDistMirror",
    '-e', "MAVEN_MIRROR=$MavenMirror",
    '-e', "LEGACY_PACKAGING=$LegacyPackaging",
    '-e', "KEYSTORE_ALIAS=$KeystoreAlias",
    '-e', "KEYSTORE_PASSWORD=$KeystorePassword",
    '-e', "KEYSTORE_FILE_NAME=$KeystoreFileName",
    '-w', '/tmp',
    $JdkImage,
    'bash', '/tmp/build-container.sh'
)

Write-Step "启动容器构建（$BuildKind / $AndroidTarget，镜像 $JdkImage，$Cpus 核）"
Write-Host '首次运行需要下载 Node / Rust / Android SDK / NDK，可能耗时较久；后续构建会复用 docker 卷。' -ForegroundColor DarkGray

try {
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "容器构建失败，退出码 $LASTEXITCODE（版本号已自增，不回滚）"
    }
} finally {
    Remove-Item -Recurse -Force $stageDir -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 收集产物
# ---------------------------------------------------------------------------
$apkRoot = Join-Path $DistDir 'outputs'
$sep = [System.IO.Path]::DirectorySeparatorChar
$apks = @(
    Get-ChildItem -Path $apkRoot -Recurse -Filter '*.apk' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match ([regex]::Escape($sep + $BuildKind + $sep)) }
)
if ($apks.Count -eq 0) {
    Fail "未找到 $BuildKind APK，请检查上方构建日志（输出目录：$apkRoot）"
}

$nameSuffix = if ($isDebug) { '-debug' } else { '' }

# 发布目录（SMB 共享）可用性检查：无法访问时保留本地，避免构建成果丢失
$shareAvailable = $false
if ($ReleaseOut) {
    try { $shareAvailable = Test-Path -LiteralPath $ReleaseOut } catch { $shareAvailable = $false }
    if (-not $shareAvailable) {
        Write-Warn "发布目录不可达：$ReleaseOut，APK 将保留在本地 $DistDir"
    }
}

$published = @()
foreach ($apk in $apks) {
    $outName = if ($apks.Count -eq 1) {
        "YunShu-Notes-v$buildVersion-$AbiName$nameSuffix.apk"
    } else {
        "YunShu-Notes-v$buildVersion-$AbiName-$($apk.BaseName)$nameSuffix.apk"
    }

    if ($shareAvailable) {
        $target = Join-Path $ReleaseOut $outName
        try {
            Move-Item -LiteralPath $apk.FullName -Destination $target -Force
        } catch {
            Write-Warn "移动到 $ReleaseOut 失败：$($_.Exception.Message)，改为保留在本地"
            $shareAvailable = $false
            $target = Join-Path $DistDir $outName
            Copy-Item -LiteralPath $apk.FullName -Destination $target -Force
        }
    } else {
        $target = Join-Path $DistDir $outName
        Copy-Item -LiteralPath $apk.FullName -Destination $target -Force
    }
    $published += $target
}

Write-Host ''
Write-Host '构建完成！' -ForegroundColor Cyan
Write-Host "版本：$buildVersion（$BuildKind / $AbiName）" -ForegroundColor Yellow
if ($shareAvailable) {
    Write-Host "APK 已移动到：$ReleaseOut" -ForegroundColor Green
} else {
    Write-Host "APK 保留在本地：$DistDir" -ForegroundColor Yellow
}
$published | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Green }

$openDir = if ($shareAvailable) { $ReleaseOut } else { $DistDir }
Start-Process explorer.exe $openDir

#!/usr/bin/env bash
# 云树笔记 飞牛 NAS 一键部署：本机构建服务端镜像 + 前端静态包 → 备份 SQLite → 推送飞牛 →
# docker load → compose 回填重建 → 健康检查 → 前端原子切换 → 两端清理旧镜像/旧包。
# 参照 quantum/scripts/deploy-prod.sh 的「本机构建、飞牛只负责运行」口径：
#   - 本机 docker build 全量工作区（未提交改动一并构建进镜像，部署即所见）；
#   - 镜像以时间戳 tag 推送，远端 compose 的 image 行由本脚本回填（以仓库 deploy/nas/docker-compose.yml 为权威）；
#   - 更新前自动对 SQLite 做在线快照（VACUUM INTO，WAL 安全），备份落在 data/backups/；
#   - 前端静态文件打到远端临时目录后整体换目录，校验 index.html 指纹，失败自动切回上一版。
#
# 一次性前置：
#   1) 本机 Docker Desktop 已启动（Windows 直接跑本脚本即可）；
#   2) SSH 免密：ssh-keygen -t ed25519 && ssh-copy-id fnos（脚本用 BatchMode 非交互，无免密会在预检失败）；
#   3) 飞牛侧已存在 /vol2/1000/docker/yunshu-notes/.env（JWT_SECRET 必填）与 nginx 容器。
#
# 回滚：
#   ./scripts/deploy-fnos.sh --load <TARDIR>/yunshu-server_<旧tag>.tar.gz      # 只回退服务端镜像
#   ./scripts/deploy-fnos.sh --load-web <TARDIR>/yunshu-web_<旧tag>.tar.gz    # 只回退前端
#   库结构/数据不回退；需要回退数据时从 data/backups/yunshu-<时间戳>.db 手工恢复。
set -euo pipefail

# Windows（Git Bash / MSYS）兜底：从 CMD / PowerShell 直接调 bash 时，继承的 Windows PATH
# 有时没被转换成 POSIX 形式，dirname / id / sed / docker 会一律 "command not found"。
case "${OSTYPE:-}" in
  msys*|cygwin*|mingw*)
    PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
    for _d in "/c/Program Files/Docker/Docker/resources/bin" \
              "${HOME:-/c/Users}/AppData/Local/Programs/DockerDesktop/resources/bin"; do
      [ -d "$_d" ] && PATH="$PATH:$_d"
    done
    export PATH
    unset _d ;;
esac

APP=yunshu-server                 # 服务端镜像名 = compose service 名 = 容器名
WEB_NAME=yunshu-web               # 前端静态包名前缀
KEEP=${KEEP:-2}                            # 清理后保留的镜像 tag 数（本机与飞牛各自执行）
KEEP_TAR=${KEEP_TAR:-3}                    # 清理后保留的部署包数（本机与飞牛各自执行）
KEEP_DB=${KEEP_DB:-10}                     # 飞牛侧保留的 SQLite 快照数
FNOS_SSH=${FNOS_SSH:-fnos}        # 飞牛 NAS SSH 目标（~/.ssh/config 别名）
REMOTE_DIR=${REMOTE_DIR:-/vol2/1000/docker/yunshu-notes}
REMOTE_COMPOSE_FILE="$REMOTE_DIR/docker-compose.yml"
REMOTE_ENV_FILE="$REMOTE_DIR/.env"
REMOTE_DATA_DIR="$REMOTE_DIR/data"
REMOTE_TARDIR=${REMOTE_TARDIR:-$REMOTE_DIR/tars}                 # 飞牛侧镜像/前端部署包目录
REMOTE_WEB_ROOT=${REMOTE_WEB_ROOT:-/vol2/1000/docker/nginx/html/notes}
NGINX_CONTAINER=${NGINX_CONTAINER:-nginx}
REMOTE_WEB_URL=${REMOTE_WEB_URL:-http://192.168.1.71:8080}       # 走 nginx 8080 入口做前端校验
REMOTE_HEALTH_URL=${REMOTE_HEALTH_URL:-http://127.0.0.1:3001/api/health}
DOCKER_NETWORK=${DOCKER_NETWORK:-docker_network}
# 基础镜像走镜像站（直连 Docker Hub 在国内常常拉不动）；置空 BASE_MIRROR= 直连官方源
BASE_MIRROR=${BASE_MIRROR-swr.cn-north-4.myhuaweicloud.com/ddn-k8s}
NODE_IMAGE=${NODE_IMAGE:-node:20-slim}

cd "$(dirname "$0")/.."
TARDIR=${TARDIR:-$PWD/.runtime-data/fnos-tars}                   # 本机部署包输出目录（.runtime-data 不入库）

# SSH 统一封装：BatchMode 禁交互（无免密立即失败）；accept-new 首连自动收录主机指纹。
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
rsh() { ssh "${SSH_OPTS[@]}" "$FNOS_SSH" "$@"; }

die() { echo "!! $*" >&2; exit 1; }

usage() {
  cat <<EOF
用法（在仓库根执行）：
  $0                      # 完整部署：备份库 → 构建服务端镜像 → 构建前端 → 推送 → 重建 → 健康检查 → 清理
  $0 --server-only        # 只更新服务端（跳过前端构建与上传）
  $0 --web-only           # 只构建并更新前端静态文件（不动容器与库）
  $0 --check              # 只做预检并打印飞牛侧当前状态，不做任何变更
  $0 --load <tar包>       # 从既有镜像 tar 部署（回滚 / 免构建），不清理镜像与部署包
  $0 --load-web <tar包>   # 从既有前端 tar 部署（前端回滚）
环境变量：
  FNOS_SSH=user@host       # 飞牛 SSH 目标（默认 $FNOS_SSH）
  TARDIR=/path             # 本机部署包目录（默认 $TARDIR）
  REMOTE_TARDIR=/path      # 飞牛部署包目录（默认 $REMOTE_TARDIR）
  BASE_MIRROR=host/path    # 基础镜像镜像站（默认 $BASE_MIRROR；置空直连官方源）
  NODE_IMAGE=node:20-slim  # 服务端基础镜像（默认 $NODE_IMAGE）
  HEALTH_CHECK_RETRIES=20  # 服务端健康检查轮数（每轮 3s）
  KEEP / KEEP_TAR / KEEP_DB  # 保留镜像数 / 部署包数 / SQLite 快照数（默认 $KEEP / $KEEP_TAR / $KEEP_DB）
EOF
}

# 读镜像 tar 包里声明的镜像名（docker load 输出走 stderr，stdout 只回传镜像名）
load_and_verify() {
  rsh bash -s -- "$1" "$APP" "${2:-}" <<'EOF'
set -e
if [ -n "${3:-}" ] && [ -f "$3" ]; then
  want=$(tr -d ' \r\n' < "$3")
  got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "!! sha256 校验失败（传输中断/远端磁盘写满）" >&2; exit 1; }
  echo "    sha256 校验通过" >&2
else
  echo "    没有 .sha256 指纹文件，跳过完整性校验" >&2
fi
out=$(docker load -i "$1")
echo "$out" >&2
img=$(echo "$out" | sed -n 's/^Loaded image: //p' | tail -n1)
[ -n "$img" ] || { echo "!! tar 包内未解析出镜像名（是否为本脚本导出的包？）" >&2; exit 1; }
case "$img" in
  "$2":*) ;;
  *) echo "!! tar 包里是 $img，不是 $2 镜像，拒绝部署" >&2; exit 1;;
esac
echo "$img"
EOF
}

# 用仓库里的 compose 模板覆盖远端，回填本次镜像 tag，再重建容器；
# 顺带核对容器实际跑的是不是目标镜像。
deploy_via_compose() {
  local img=$1
  echo "    上传 compose 模板并回填 image=$img"
  scp "${SSH_OPTS[@]}" deploy/nas/docker-compose.yml "$FNOS_SSH:$REMOTE_COMPOSE_FILE"
  rsh bash -s -- "$REMOTE_COMPOSE_FILE" "$APP" "$img" <<'EOF'
set -eu
compose=$1 app=$2 img=$3
sed -i -E "s|^([[:space:]]*)image:.*|\1image: \"$img\"|" "$compose"
grep -q "image: \"$img\"" "$compose" || { echo "!! compose image 行回填失败，请检查 $compose" >&2; exit 1; }
docker compose -f "$compose" up -d
running=$(docker inspect "$app" --format '{{.Config.Image}}')
[ "$running" = "$img" ] || { echo "!! 容器实际镜像 $running 与预期 $img 不一致" >&2; exit 1; }
EOF
}

# 健康检查：轮询宿主回环 3001（compose 只把端口绑到 127.0.0.1，SSH 就在宿主上）。
health_check() {
  rsh bash -s -- "$APP" "$REMOTE_HEALTH_URL" "${HEALTH_CHECK_RETRIES:-20}" <<'EOF'
set -u
app=$1 url=$2 retries=${3:-20} resp=""
for _ in $(seq 1 "$retries"); do
  sleep 3
  resp=$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)
  case "$resp" in *'"status":"ok"'*) break;; esac
done
docker ps -a --filter "name=^/$app\$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
docker logs "$app" --tail 30 2>&1 || true
case "$resp" in
  *'"status":"ok"'*) echo "    健康检查通过：$url" ;;
  *) echo "!! 健康检查失败（$url 返回：${resp:-无响应}），请先查上方日志" >&2; exit 1 ;;
esac
EOF
}

# 更新前备份 SQLite：容器内用 better-sqlite3 做在线快照（VACUUM INTO，WAL 内容一并落盘）。
backup_db() {
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  echo "    落盘 data/backups/yunshu-$stamp.db"
  rsh bash -s -- "$APP" "$KEEP_DB" "$stamp" <<'EOF'
set -eu
app=$1 keep=$2 stamp=$3
if ! [ "$(docker inspect -f '{{.State.Running}}' "$app" 2>/dev/null || echo false)" = "true" ]; then
  echo "    容器未运行，跳过库备份（启动前无并发写入）" >&2
  exit 0
fi
name="yunshu-$stamp.db"
docker exec "$app" sh -c "mkdir -p /data/backups && rm -f '/data/backups/$name.tmp'"
docker exec "$app" node -e '
const Database = require("better-sqlite3");
const dest = String(process.argv[1]).replace(/\x27/g, "\x27\x27");
const db = new Database(process.env.SQLITE_PATH);
db.exec("VACUUM INTO \x27" + dest + "\x27");
db.close();
' "/data/backups/$name.tmp"
docker exec "$app" sh -c "mv '/data/backups/$name.tmp' '/data/backups/$name'"
docker exec "$app" sh -c "ls -1t /data/backups/yunshu-*.db | tail -n +$((keep + 1)) | xargs -r rm -f"
docker exec "$app" sh -c "du -h '/data/backups/$name'"
EOF
}

# 前端部署：解包到同级临时目录 → 换目录 → 校验线上 index.html 指纹 → 失败自动切回上一版。
deploy_web() {
  local tar_remote=$1 want_sha=$2
  rsh bash -s -- "$REMOTE_WEB_ROOT" "$tar_remote" "$want_sha" "$REMOTE_WEB_URL" <<'EOF'
set -eu
root=$1 tar=$2 want=$3 url=$4
parent=$(dirname "$root"); base=$(basename "$root")
new="$parent/.$base.new"; old="$parent/.$base.old"
rm -rf "$new" "$old"
mkdir -p "$new"
tar xzf "$tar" -C "$new"
[ -f "$new/index.html" ] || { echo "!! 前端包内缺 index.html" >&2; exit 1; }
chmod -R a+rX "$new"
mv "$root" "$old"
mv "$new" "$root"
got=""
for _ in $(seq 1 10); do
  got=$(curl -fsS --max-time 5 "$url/index.html" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
  [ "$got" = "$want" ] && break
  sleep 1
done
if [ "$got" != "$want" ]; then
  rm -rf "$root"; mv "$old" "$root"
  echo "!! 前端校验失败（线上 $got / 期望 $want），已恢复上一版" >&2
  exit 1
fi
rm -rf "$old"
echo "    前端已切换并通过校验（index.html sha256 ${want:0:12}…）"
EOF
  # 再确认 nginx 到后端的链路是通的
  rsh bash -s -- "$REMOTE_WEB_URL" <<'EOF'
set -eu
resp=$(curl -fsS --max-time 5 "$1/api/health" 2>/dev/null || true)
case "$resp" in
  *'"status":"ok"'*) echo "    nginx → API 链路正常" ;;
  *) echo "!! 经 nginx 访问 $1/api/health 失败（返回：${resp:-无响应}）" >&2; exit 1 ;;
esac
EOF
}

# 只清理前端旧包（--web-only 不动镜像）
prune_web() {
  rsh bash -s -- "$WEB_NAME" "$REMOTE_TARDIR" "$KEEP_TAR" <<'EOF'
set -u
web=$1 tardir=$2 keeptar=$3
ls -t "$tardir"/"$web"_*.tar.gz 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧前端包清理失败（不影响本次部署）" >&2
ls -t "$tardir"/"$web"_*.tar.gz.sha256 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧前端包指纹清理失败（不影响本次部署）" >&2
exit 0
EOF
  ls -t "$TARDIR"/${WEB_NAME}_*.tar.gz 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧前端包清理失败（不影响本次部署）" >&2
  ls -t "$TARDIR"/${WEB_NAME}_*.tar.gz.sha256 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧前端包指纹清理失败（不影响本次部署）" >&2
}

prune_remote() {
  rsh bash -s -- "$APP" "$WEB_NAME" "$KEEP" "$REMOTE_TARDIR" "$KEEP_TAR" <<'EOF'
set -u
app=$1 web=$2 keep=$3 tardir=$4 keeptar=$5
docker images --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' "$app" \
  | grep -v ':<none>$' | sort -r | tail -n +$((keep + 1)) | cut -f2 \
  | xargs -r docker rmi || echo "!! 飞牛旧镜像清理失败（不影响本次部署）" >&2
ls -t "$tardir"/"$app"_*.tar.gz 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧镜像包清理失败（不影响本次部署）" >&2
ls -t "$tardir"/"$app"_*.tar.gz.sha256 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧镜像指纹清理失败（不影响本次部署）" >&2
ls -t "$tardir"/"$web"_*.tar.gz 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧前端包清理失败（不影响本次部署）" >&2
ls -t "$tardir"/"$web"_*.tar.gz.sha256 2>/dev/null | tail -n +$((keeptar + 1)) | xargs -r rm -f \
  || echo "!! 飞牛旧前端包指纹清理失败（不影响本次部署）" >&2
exit 0
EOF
}

prune_local() {
  docker images --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' "$APP" \
    | grep -v ':<none>$' | sort -r | tail -n +$((KEEP + 1)) | cut -f2 \
    | xargs -r docker rmi || echo "!! 本机旧镜像清理失败（不影响本次部署）" >&2
  ls -t "$TARDIR"/${APP}_*.tar.gz 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧镜像包清理失败（不影响本次部署）" >&2
  ls -t "$TARDIR"/${APP}_*.tar.gz.sha256 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧镜像指纹清理失败（不影响本次部署）" >&2
  ls -t "$TARDIR"/${WEB_NAME}_*.tar.gz 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧前端包清理失败（不影响本次部署）" >&2
  ls -t "$TARDIR"/${WEB_NAME}_*.tar.gz.sha256 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧前端包指纹清理失败（不影响本次部署）" >&2
  true
}

mirror_ref() {
  case "$1" in
    */*)
      case "${1%%/*}" in
        *.*|*:*|localhost) echo "$BASE_MIRROR/$1" ;;
        *) echo "$BASE_MIRROR/docker.io/$1" ;;
      esac ;;
    *) echo "$BASE_MIRROR/docker.io/library/$1" ;;
  esac
}

# 确认基础镜像在本地（镜像站优先，失败回落官方源），把 --build-arg 追加到 BUILD_ARGS。
prepare_base_image() {
  local ref=$NODE_IMAGE mref=$NODE_IMAGE
  if [ -n "$BASE_MIRROR" ]; then mref=$(mirror_ref "$ref"); fi
  if ! docker image inspect "$mref" >/dev/null 2>&1; then
    echo "    本地缺 $mref，开始拉取"
    if ! docker pull "$mref"; then
      if [ "$mref" = "$ref" ]; then
        die "拉不到基础镜像 $ref，终止部署"
      fi
      echo "!! 镜像站拉不到 $mref，回落官方源（国内可能极慢）" >&2
      mref=$ref
      docker image inspect "$ref" >/dev/null 2>&1 || docker pull "$ref"
    fi
  fi
  BUILD_ARGS+=(--build-arg "NODE_IMAGE=$mref")
}

# 构建前端并立即打包：构建输出到脚本私有目录（不碰 apps/web/dist），
# 避免与 Tauri / Android 等并行构建互相覆盖；打包完成后立刻删除临时目录。
build_web() {
  local tag=$1
  local out="$PWD/.runtime-data/web-build-$tag"
  command -v npm >/dev/null 2>&1 || die "本机缺 npm（需 Node.js 20+ 才能构建前端）"
  if [ ! -d node_modules ]; then
    echo "    本地缺 node_modules，先执行 npm install"
    npm install --no-audit --no-fund
  fi
  rm -rf "$out"
  npm run build --workspace=@yunshu/web -- --outDir "../../.runtime-data/web-build-$tag" --emptyOutDir
  [ -f "$out/index.html" ] || die "前端构建产物缺 $out/index.html"
  WEB_INDEX_SHA=$(sha256sum "$out/index.html" | cut -d' ' -f1)
  mkdir -p "$TARDIR"
  WEB_TAR="$TARDIR/${WEB_NAME}_${tag}.tar.gz"
  tar czf "$WEB_TAR" -C "$out" .
  sha256sum "$WEB_TAR" | cut -d' ' -f1 > "$WEB_TAR.sha256"
  rm -rf "$out"
  du -h "$WEB_TAR"
}

# 推送已打包好的前端 tar（build_web 或 --load-web 准备的包）。
push_web() {
  rsh "mkdir -p '$REMOTE_TARDIR'"
  scp "${SSH_OPTS[@]}" "$WEB_TAR" "$WEB_TAR.sha256" "$FNOS_SSH:$REMOTE_TARDIR/"
}

# 读取远端 compose 当前 image 行（用于「原镜像」提示与回滚指引）
current_image() {
  rsh bash -s -- "$REMOTE_COMPOSE_FILE" <<'EOF'
sed -n 's/^[[:space:]]*image:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$1" 2>/dev/null | head -n1
EOF
}

MODE=full
LOAD_TAR=""
LOAD_WEB_TAR=""
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --check) MODE=check ;;
  --server-only) MODE=server ;;
  --web-only) MODE=web ;;
  --load)
    MODE=load
    LOAD_TAR=${2:?用法: $0 --load <tar包路径>}
    [ -r "$LOAD_TAR" ] || die "tar 包不存在: $LOAD_TAR" ;;
  --load-web)
    MODE=web-load
    LOAD_WEB_TAR=${2:?用法: $0 --load-web <前端tar包路径>}
    [ -r "$LOAD_WEB_TAR" ] || die "前端 tar 包不存在: $LOAD_WEB_TAR" ;;
  "") ;;
  *) die "未知参数: $1（--help 看用法）" ;;
esac

case "$MODE" in
  full) STEPS=9 ;;
  server) STEPS=7 ;;
  web) STEPS=4 ;;
  web-load) STEPS=3 ;;
  load) STEPS=5 ;;
  check) STEPS=0 ;;
esac
STEP=0
step() { STEP=$((STEP + 1)); echo "==> [$STEP/$STEPS] $*"; }

echo "==> [0/$STEPS] 预检：本机 docker / SSH 免密 / 飞牛部署目录（确认无并行会话在操作）"
docker info >/dev/null 2>&1 || die "本机 docker 不可用（Docker Desktop 是否已启动？）"
LOCAL_ARCH=$(docker info --format '{{.Architecture}}')
if ! msg=$(rsh 'docker info >/dev/null 2>&1' 2>&1); then
  echo "!! SSH 免密登录 $FNOS_SSH 失败或远端 docker 不可用：$msg" >&2
  echo "   首次配置：ssh-keygen -t ed25519 -N '' && ssh-copy-id $FNOS_SSH" >&2
  exit 1
fi
REMOTE_ARCH=$(rsh "docker info --format '{{.Architecture}}'")
[ "$LOCAL_ARCH" = "$REMOTE_ARCH" ] || die "本机架构 $LOCAL_ARCH 与飞牛 $REMOTE_ARCH 不一致，镜像无法直接 load"
rsh bash -s -- "$REMOTE_DIR" "$REMOTE_ENV_FILE" "$REMOTE_DATA_DIR" "$REMOTE_WEB_ROOT" "$NGINX_CONTAINER" "$DOCKER_NETWORK" "$APP" <<'EOF'
set -eu
dir=$1 env=$2 data=$3 webroot=$4 nginx=$5 net=$6 app=$7
[ -d "$dir" ] || { echo "!! 远端缺部署目录 $dir" >&2; exit 1; }
[ -d "$data" ] || { echo "!! 远端缺数据目录 $data" >&2; exit 1; }
grep -q '^JWT_SECRET=..*' "$env" 2>/dev/null || { echo "!! $env 缺 JWT_SECRET（先放好 .env 再部署）" >&2; exit 1; }
[ -d "$webroot" ] || { echo "!! 远端缺前端目录 $webroot" >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$nginx" 2>/dev/null || echo false)" = "true" ] \
  || { echo "!! 远端 nginx 容器 $nginx 未运行" >&2; exit 1; }
docker network inspect "$net" >/dev/null 2>&1 || { echo "!! 远端缺 docker 网络 $net" >&2; exit 1; }
docker compose version >/dev/null || { echo "!! 远端 docker compose 子命令不可用" >&2; exit 1; }
echo "    飞牛侧当前容器状态："
docker ps -a --filter "name=^/$app\$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
EOF
PREV=$(current_image)
if [ -n "$PREV" ]; then echo "    当前镜像 $PREV"; else echo "    远端尚无 compose image 行（首次部署）"; fi

if [ "$MODE" = check ]; then
  echo "    本机 docker 架构：$LOCAL_ARCH；远端前端目录：$REMOTE_WEB_ROOT"
  echo "    预检通过（--check 模式，未做任何变更）"
  exit 0
fi

# 记录上一版部署包（清理与回滚提示用），必须在生成新包之前取
PREV_IMG_TAR=$(ls -1t "$TARDIR"/${APP}_*.tar.gz 2>/dev/null | head -n1 || true)
PREV_WEB_TAR=$(ls -1t "$TARDIR"/${WEB_NAME}_*.tar.gz 2>/dev/null | head -n1 || true)
TAG=$(date +%Y%m%d-%H%M)

if [ "$MODE" = web ] || [ "$MODE" = web-load ]; then
  # ---------- 只更新前端 ----------
  if [ "$MODE" = web ]; then
    n=1
    while [ -f "$TARDIR/${WEB_NAME}_$TAG.tar.gz" ] \
       || rsh "test -f '$REMOTE_TARDIR/${WEB_NAME}_$TAG.tar.gz'"; do
      TAG="$(date +%Y%m%d-%H%M)-$((n++))"
    done
    step "本机构建并打包前端"
    build_web "$TAG"
    step "推送前端包到飞牛 $REMOTE_TARDIR"
    push_web
    WANT_WEB_SHA=$WEB_INDEX_SHA
  else
    step "推送既有前端包到飞牛"
    rsh "mkdir -p '$REMOTE_TARDIR'"
    base=$(basename "$LOAD_WEB_TAR")
    scp "${SSH_OPTS[@]}" "$LOAD_WEB_TAR" "$FNOS_SSH:$REMOTE_TARDIR/"
    if [ -f "$LOAD_WEB_TAR.sha256" ]; then
      scp "${SSH_OPTS[@]}" "$LOAD_WEB_TAR.sha256" "$FNOS_SSH:$REMOTE_TARDIR/"
      rsh bash -s -- "$REMOTE_TARDIR/$base" "$REMOTE_TARDIR/$base.sha256" <<'EOF'
set -e
want=$(tr -d ' \r\n' < "$2"); got=$(sha256sum "$1" | cut -d' ' -f1)
[ "$want" = "$got" ] || { echo "!! sha256 校验失败（传输中断/远端磁盘写满）" >&2; exit 1; }
echo "    sha256 校验通过"
EOF
    fi
    WANT_WEB_SHA=$(tar xzOf "$LOAD_WEB_TAR" ./index.html 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
    [ -n "$WANT_WEB_SHA" ] && [ "$WANT_WEB_SHA" != "$(printf '' | sha256sum | cut -d' ' -f1)" ] \
      || die "读不到前端包内的 index.html"
  fi
  step "切换前端目录并校验"
  deploy_web "$REMOTE_TARDIR/$(basename "${WEB_TAR:-$LOAD_WEB_TAR}")" "$WANT_WEB_SHA"
  if [ "$MODE" = web ]; then
    step "清理旧前端包（飞牛 + 本机各保留 $KEEP_TAR 个）"
    prune_web
  fi
  echo "==> 完成：前端已更新（$REMOTE_WEB_URL）"
  if [ -n "$PREV_WEB_TAR" ]; then
    echo "    回到上一版前端：$0 --load-web $PREV_WEB_TAR"
  fi
  exit 0
fi

if [ "$MODE" = load ]; then
  # ---------- 从既有镜像 tar 部署（回滚） ----------
  step "备份 yunshu SQLite"
  backup_db
  step "推送 tar 到飞牛并 docker load"
  rsh "mkdir -p '$REMOTE_TARDIR'"
  TAR_BASE=$(basename "$LOAD_TAR")
  scp "${SSH_OPTS[@]}" "$LOAD_TAR" "$FNOS_SSH:$REMOTE_TARDIR/"
  [ -f "$LOAD_TAR.sha256" ] && scp "${SSH_OPTS[@]}" "$LOAD_TAR.sha256" "$FNOS_SSH:$REMOTE_TARDIR/"
  IMG=$(load_and_verify "$REMOTE_TARDIR/$TAR_BASE" "$REMOTE_TARDIR/$TAR_BASE.sha256")
  step "重建容器"
  deploy_via_compose "$IMG"
  step "健康检查"
  health_check
  echo "==> [$STEPS/$STEPS] 完成：已从 tar 包部署 $IMG（原镜像 ${PREV:-无}）"
  echo "    回滚模式不清理镜像与部署包；库结构未回退，数据需要回退请用 data/backups/ 下的快照"
  exit 0
fi

# ---------- 服务端构建 / 完整部署 ----------
n=1
while docker image inspect "$APP:$TAG" >/dev/null 2>&1 \
   || rsh "docker image inspect '$APP:$TAG' >/dev/null 2>&1"; do
  TAG="$(date +%Y%m%d-%H%M)-$((n++))"
done

step "备份 yunshu SQLite"
backup_db

if [ "$MODE" = full ]; then
  step "本机构建并打包前端"
  build_web "$TAG"
fi
git diff --quiet || echo "    注意：工作区有未提交改动，将一并构建进本次镜像"
if [ "$MODE" = full ]; then
  step "构建服务端镜像 $APP:$TAG（工作区全量构建）"
else
  step "构建服务端镜像 $APP:$TAG（工作区全量构建，跳过前端）"
fi
BUILD_ARGS=()
prepare_base_image
docker build "${BUILD_ARGS[@]}" -f apps/server/Dockerfile -t "$APP:$TAG" .

step "导出回滚 tar 到本机 $TARDIR"
mkdir -p "$TARDIR"
TAR="$TARDIR/${APP}_${TAG}.tar.gz"
TAR_SHA="$TAR.sha256"
docker save "$APP:$TAG" | gzip -1 > "$TAR"
sha256sum "$TAR" | cut -d' ' -f1 > "$TAR_SHA"
du -h "$TAR"

step "推送飞牛 $REMOTE_TARDIR 并 docker load"
rsh "mkdir -p '$REMOTE_TARDIR'"
scp "${SSH_OPTS[@]}" "$TAR" "$TAR_SHA" "$FNOS_SSH:$REMOTE_TARDIR/"
IMG=$(load_and_verify "$REMOTE_TARDIR/${APP}_${TAG}.tar.gz" "$REMOTE_TARDIR/${APP}_${TAG}.tar.gz.sha256")
[ "$IMG" = "$APP:$TAG" ] || die "远端 load 出 $IMG，与刚构建的 $APP:$TAG 不一致"

step "重建容器（远端 compose）"
deploy_via_compose "$IMG"

step "服务端健康检查"
health_check

if [ "$MODE" = full ]; then
  step "推送前端包"
  push_web
  deploy_web "$REMOTE_TARDIR/${WEB_NAME}_${TAG}.tar.gz" "$WEB_INDEX_SHA"
fi

step "清理旧镜像与旧部署包（飞牛 + 本机，各保留镜像 $KEEP 个 / 包 $KEEP_TAR 个）"
prune_remote
prune_local

echo "==> 完成：$APP:$TAG 已上线（原镜像 ${PREV:-无}）"
echo "    外网：https://note.678120.cn:8888    内网：$REMOTE_WEB_URL"
echo "    本次部署包：$TAR（飞牛侧 $REMOTE_TARDIR/${APP}_${TAG}.tar.gz）"
if [ -n "$PREV_IMG_TAR" ]; then
  echo "    回到上一版服务端：$0 --load $PREV_IMG_TAR"
else
  echo "    回到上一版服务端：本机没有更早的 tar，可从飞牛 $REMOTE_TARDIR 取包后 --load"
fi
if [ "$MODE" = full ]; then
  if [ -n "$PREV_WEB_TAR" ]; then
    echo "    回到上一版前端：$0 --load-web $PREV_WEB_TAR"
  else
    echo "    回到上一版前端：本机没有更早的前端包，可从飞牛 $REMOTE_TARDIR 取包后 --load-web"
  fi
fi

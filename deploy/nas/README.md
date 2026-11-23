# 云树笔记 NAS 部署（fnOS / 192.168.1.71）

本目录是 NAS 上 `/vol2/1000/docker/yunshu-notes/` 栈的参考副本。

## 目录结构（NAS）

```text
/vol2/1000/docker/yunshu-notes/
├── docker-compose.yml       # 服务端容器（image tag 由部署脚本回填）
├── .env                     # JWT_SECRET / PUBLIC_API_BASE（不入库）
├── tars/                    # 镜像与前端部署包（--load / --load-web 回滚用）
└── data/                    # SQLite 数据库、附件、预览；data/backups/ 为每次更新的库快照

/vol2/1000/docker/nginx/
├── conf/nginx.conf          # 已追加 note.678120.cn vhost
└── html/notes/              # Web 前端构建产物（部署脚本上传）
```

## 访问地址

- 外网 / 内网统一入口：`https://note.678120.cn:8888`
  （家宽 80/443 入站被运营商封禁，所有 `*.678120.cn` 站点均走 8888）
- 局域网直接 IP（无需 DNS）：`http://192.168.1.71:8080`
  （80/443 被 fnOS 系统 nginx 占用，容器 nginx 无法使用）
- 局域网 IP + HTTPS：`https://192.168.1.71:8888`
  （通配符证书不覆盖 IP，浏览器会提示证书不受信任，仅建议临时使用）
- 服务端健康检查：`https://note.678120.cn:8888/api/health` 或 `http://192.168.1.71:8080/api/health`

## 一键部署（推荐）

在开发机仓库根执行（Windows 用 Git Bash；Linux / macOS 直接跑）：

```bash
./scripts/deploy-fnos.sh            # 完整部署：备份库 → 构建服务端镜像 → 构建前端 → 推送 → 重建 → 健康检查 → 清理
./scripts/deploy-fnos.sh --check    # 只预检并打印飞牛当前状态，不做任何变更
```

脚本在本机构建服务端镜像（`apps/server/Dockerfile`，工作区全量内容）和前端静态文件，
经 SSH 推送到飞牛后 `docker load`、回填 `docker-compose.yml` 的 image tag 并重建容器；
更新前用容器内的 better-sqlite3 对 SQLite 做在线快照，存到 `data/backups/`（保留最近 10 份）；
前端整目录原子切换并校验 `index.html` 指纹，校验失败自动切回上一版。

常用模式：

```bash
./scripts/deploy-fnos.sh --server-only    # 只更新服务端（跳过前端）
./scripts/deploy-fnos.sh --web-only       # 只更新前端静态文件（不动容器与库）
./scripts/deploy-fnos.sh --load <tar>     # 用既有镜像包部署（回滚 / 免构建）
./scripts/deploy-fnos.sh --load-web <tar> # 用既有前端包部署（前端回滚）
```

部署包默认保存在本机 `.runtime-data/fnos-tars/` 与飞牛 `tars/`，两边各保留最近 3 份。

### 首次部署前置

1. 本机 Docker Desktop 已启动，且 SSH 免密可登录飞牛：`ssh-keygen -t ed25519 && ssh-copy-id fnos`
2. 飞牛侧目录与 `.env`（`JWT_SECRET` 必须随机且妥善保存，修改会让所有登录态失效）：

   ```bash
   ssh fnos 'mkdir -p /vol2/1000/docker/yunshu-notes/{data,tars} && cd /vol2/1000/docker/yunshu-notes && \
     umask 077 && printf "PUBLIC_API_BASE=https://note.678120.cn:8888\nJWT_SECRET=%s\nALLOW_REGISTRATION=false\n" \
     "$(openssl rand -hex 32)" > .env'
   ```

3. 飞牛侧存在 `nginx` 容器、`docker_network` 网络与前端目录 `/vol2/1000/docker/nginx/html/notes`（见下文 vhost）。
4. 在开发机仓库根执行 `./scripts/deploy-fnos.sh` 完成首次部署。

## nginx vhost

完整片段见 [nginx-note.678120.cn.conf](nginx-note.678120.cn.conf)。要点：

- `server_name note.678120.cn; listen 8888 ssl;`，证书为通配符 `*.678120.cn`。
- `root /usr/share/nginx/html/notes;` + `try_files $uri $uri/ /index.html;` 服务 SPA。
- `location /api/ { proxy_pass http://127.0.0.1:3001; }` 反代 Fastify（含签名上传/下载 `/api/v1/files/blob`）。
- 修改 `nginx.conf` 后先 `docker exec nginx nginx -t`，再 `nginx -s reload`。

## 内网 DNS（split DNS）

`note.678120.cn` 公网是 CNAME 到 `fn.678120.cn`，AdGuard 不会对 CNAME 目标套用重写，因此内网需显式加两条：

- AdGuard Home 重写：`note.678120.cn → 192.168.1.71`
- openwrt dnsmasq 静态条目：`/etc/config/dhcp` 中 `config domain`（`option name 'note.678120.cn'` / `option ip '192.168.1.71'`）

改完 AdGuard 需清缓存，dnsmasq 需 `/etc/init.d/dnsmasq restart`。

## 账号管理

注册入口默认关闭（`.env` 中 `ALLOW_REGISTRATION=false`），登录页只保留登录，服务端也会对
`POST /api/v1/auth/register` 返回 403。

需要新增账号时：

```bash
# 1. 临时开启注册
ssh fnos 'cd /vol2/1000/docker/yunshu-notes && sed -i "s/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=true/" .env && docker compose up -d'

# 2. 在页面上注册新账号

# 3. 关闭注册
ssh fnos 'cd /vol2/1000/docker/yunshu-notes && sed -i "s/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/" .env && docker compose up -d'
```

已有账号的登录态不受影响（`JWT_SECRET` 不变）。

## 客户端连接

Windows exe / Android APK 首次启动时，登录页会显示「服务端地址」输入框：

```text
https://note.678120.cn:8888
```

- 点击「测试连接」确认可达后，再输入邮箱密码登录。
- 地址会保存在客户端本地；需要更换时，先退出登录，再修改服务器地址。
- 手机端请使用 `https://` 域名地址；`http://192.168.1.71:8080` 仅适合局域网 Windows 客户端（Android 9+ 默认拦截明文 HTTP）。
- 客户端不再依赖构建时的 `VITE_API_BASE`，同一份 exe/APK 可连接不同服务端。

## 更新与回滚

日常更新直接执行 `./scripts/deploy-fnos.sh`（脚本已包含库备份、重建、健康检查与旧包清理）。
回滚只回退镜像 / 静态文件，数据库结构与数据不回退：

```bash
# 服务端：用本机（或从飞牛 tars/ 取回）的旧镜像包
./scripts/deploy-fnos.sh --load .runtime-data/fnos-tars/yunshu-server_<旧tag>.tar.gz

# 前端
./scripts/deploy-fnos.sh --load-web .runtime-data/fnos-tars/yunshu-web_<旧tag>.tar.gz
```

数据也需要回退时：先 `docker stop yunshu-server`，用 `data/backups/yunshu-<时间戳>.db`
覆盖 `data/yunshu.db`（连同 `-wal` / `-shm` 一并删掉），再 `docker start yunshu-server`。

## 备份

每次部署都会自动在 `data/backups/` 留一份 SQLite 快照（保留最近 10 份）。手工全量备份：

```bash
ssh fnos 'tar czf - -C /vol2/1000/docker/yunshu-notes data' > yunshu-data-$(date +%Y%m%d).tar.gz
```

## 说明

- 服务端仅监听 `127.0.0.1:3001`（API）与 `127.0.0.1:3002`（Yjs WebSocket），由宿主 nginx 暴露。
- `JWT_SECRET` 同时用于登录令牌与文件签名 URL，修改会导致所有登录态与旧下载链接失效。

# 云树笔记 NAS 部署（fnOS / 192.168.1.71）

本目录是 NAS 上 `/vol2/1000/docker/yunshu-notes/` 栈的参考副本。

## 目录结构（NAS）

```text
/vol2/1000/docker/yunshu-notes/
├── docker-compose.yml       # 服务端容器
├── .env                     # JWT_SECRET / PUBLIC_API_BASE（不入库）
├── app/                     # 构建上下文（仓库的 package.json、packages/shared、apps/server）
└── data/                    # SQLite 数据库、附件、预览（持久化，备份只需复制此目录）

/vol2/1000/docker/nginx/
├── conf/nginx.conf          # 已追加 note.678120.cn vhost
└── html/notes/              # Web 前端构建产物（apps/web/dist）
```

## 访问地址

- 外网 / 内网统一入口：`https://note.678120.cn:8888`
  （家宽 80/443 入站被运营商封禁，所有 `*.678120.cn` 站点均走 8888）
- 局域网直接 IP（无需 DNS）：`http://192.168.1.71:8080`
  （80/443 被 fnOS 系统 nginx 占用，容器 nginx 无法使用）
- 局域网 IP + HTTPS：`https://192.168.1.71:8888`
  （通配符证书不覆盖 IP，浏览器会提示证书不受信任，仅建议临时使用）
- 服务端健康检查：`https://note.678120.cn:8888/api/health` 或 `http://192.168.1.71:8080/api/health`

## 首次部署

```bash
# 1. 上传服务端源码（在仓库根目录执行）
tar czf - --exclude='node_modules' --exclude='*/node_modules' \
  --exclude='dist' --exclude='*/dist' \
  package.json tsconfig.base.json packages/shared apps/server \
  | ssh fnos 'rm -rf /vol2/1000/docker/yunshu-notes/app && mkdir -p /vol2/1000/docker/yunshu-notes/app && tar xzf - -C /vol2/1000/docker/yunshu-notes/app'

# 2. 上传 compose / 配置
scp deploy/nas/docker-compose.yml fnos:/vol2/1000/docker/yunshu-notes/docker-compose.yml

# 3. 生成 .env（JWT_SECRET 必须随机且妥善保存）
ssh fnos 'cd /vol2/1000/docker/yunshu-notes && umask 077 && \
  printf "PUBLIC_API_BASE=https://note.678120.cn:8888\nJWT_SECRET=%s\n" "$(openssl rand -hex 32)" > .env'

# 4. 构建并启动
ssh fnos 'cd /vol2/1000/docker/yunshu-notes && docker compose up -d --build'

# 5. 上传前端静态文件
npm run build:web
cd apps/web/dist && tar czf - . | ssh fnos 'mkdir -p /vol2/1000/docker/nginx/html/notes && tar xzf - -C /vol2/1000/docker/nginx/html/notes'

# 6. 确认 nginx vhost 已存在并重载
ssh fnos 'docker exec nginx nginx -t && docker exec nginx nginx -s reload'
```

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

## 更新

```bash
# 服务端：重新上传 app/ 后
ssh fnos 'cd /vol2/1000/docker/yunshu-notes && docker compose up -d --build'

# 前端：重新 build:web 后覆盖 html/notes 即可，无需重载 nginx
```

## 备份

```bash
ssh fnos 'tar czf - -C /vol2/1000/docker/yunshu-notes data' > yunshu-data-$(date +%Y%m%d).tar.gz
```

## 说明

- 服务端仅监听 `127.0.0.1:3001`（API）与 `127.0.0.1:3002`（Yjs WebSocket），由宿主 nginx 暴露。
- `JWT_SECRET` 同时用于登录令牌与文件签名 URL，修改会导致所有登录态与旧下载链接失效。

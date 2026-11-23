# 云树笔记（YunShu Notes）— 极简 SQLite 跨端中文笔记平台

面向 **Windows PC / Web / Android / 自建服务端** 的 OneNote 替代方案，全中文界面。
**已彻底移除 PostgreSQL、MinIO/S3 与 Redis**——整个服务端仅需一个 Node.js 进程，所有笔记与目录树存入单个 SQLite 文件（`data/yunshu.db`），Word/Excel/PDF 附件与预览直接保存在本地 `data/files/` 目录，备份只需复制 `data/` 文件夹。

## 核心架构与功能

- **零外部中间件**：SQLite WAL 模式 + 本地磁盘短时签名直传 + 进程内异步队列（Word/Excel 纯文本抽取与可选 LibreOffice PDF 预览），无需安装 Docker、PostgreSQL、Redis 或 MinIO 即可直接运行。
- **无限层级目录树（取消笔记本概念）**：基于 `/root/<id1>/<id2>/` 物化路径与 LexoRank 小数排序键，支持任意深度嵌套、鼠标拖拽排序/设子级、防循环引用移动与回收站。
- **富文本与 Markdown**：基于 Tiptap + Hocuspocus Yjs 实时协同同步，支持 Markdown 快捷键、导入 `.md` 与导出 `.md`。
- **Office 文件管理与 PC 本机唤起自动回传**：Windows Tauri 2.0 客户端点击「用本机 Office 打开」直接调用系统 Word / Excel / WPS，Rust 后台自动监听父目录（兼容 `~$` 锁文件与原子替换保存），按 `Ctrl+S` 自动上传新版本并支持版本历史回滚与冲突副本保护。
- **OneNote 一键迁移**：支持本地 `.onepkg` / 导出 HTML 批量导入及 Microsoft Graph API 限流断点续传。

## Windows 极速启动（无需 Docker！）

1. 安装 [Node.js 20 LTS](https://nodejs.org/)
2. 双击运行 `scripts/start-windows.bat`（自动安装依赖、启动 SQLite 服务端与 Web 前端，并打开 `http://localhost:5173`）

## 一键构建 Windows PC 与 Android APK

> 客户端首次启动时，在登录页的「服务端地址」中填写自建服务端，例如
> `https://note.678120.cn:8888`（手机端请使用 `https://` 域名），点击「测试连接」通过后即可登录。
> 地址保存在客户端本地；需要更换时先退出登录再修改。

- **构建 Windows 客户端**：安装 [Rust](https://rustup.rs/) 后双击 `scripts/build-windows-pc.bat`
  - 产出单文件 exe，并打包为绿色版 `YunShu-Notes_v<版本>_x64.zip`（附 `.sha256`）
  - 默认发布到 `\\192.168.1.71\code`（可用 `-ReleaseOut` 修改，共享不可达时保留在 `apps/tauri-app/dist/windows/`）；`-NoPackage` 可只出 exe，`-NoInstall` 可跳过 npm install
  - exe 默认开启体积优化（Cargo release profile：strip / LTO / `opt-level="z"` / `panic="abort"`，参照 terminal-buddy 的发布配置）
- **构建 Android `.apk` 安装包**：安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 后双击 `scripts/build-android-apk.bat`
  - 无需在宿主机安装 Rust、JDK、Android Studio / SDK / NDK，全部在 `eclipse-temurin:17-jdk` 容器内构建
  - 默认产出**已签名 release APK**：首次运行自动生成自签名证书（`apps/tauri-app/keystore/`，已 gitignore，请自行备份），版本号每次构建自动 +1；构建成功后 APK 自动移动到 `\\192.168.1.71\code`（可用 `-ReleaseOut` 修改，共享不可达时保留在 `apps/tauri-app/dist/android/`）
  - 依赖缓存在 docker 卷中（`yunshu-android-sdk` / `yunshu-gradle-cache` / `yunshu-cargo-home` 等），首次构建需下载约 2GB，之后可增量复用

## 可选：单容器 Docker 部署

```powershell
docker compose -f deploy/docker-compose.yml up -d
```

## 飞牛 NAS 一键部署

开发机仓库根执行（需 Docker Desktop 与飞牛 SSH 免密）：

```bash
./scripts/deploy-fnos.sh          # 备份库 → 本机构建镜像/前端 → 推送飞牛 → 重建 → 健康检查 → 清理
./scripts/deploy-fnos.sh --check  # 只预检
```

详见 [deploy/nas/README.md](deploy/nas/README.md)。

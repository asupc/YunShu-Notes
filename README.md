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

- **构建 Windows `.exe` / `.msi` 安装包**：安装 [Rust](https://rustup.rs/) 后双击 `scripts/build-windows-pc.bat`
- **构建 Android `.apk` 安装包**：安装 Rust 与 Android Studio（配置 `ANDROID_HOME` 和 `NDK_HOME`）后双击 `scripts/build-android-apk.bat`

## 可选：单容器 Docker 部署

```powershell
docker compose -f deploy/docker-compose.yml up -d
```

-- 云树笔记 SQLite 初始化建表脚本（WAL 模式 + 物化路径前缀索引）
PRAGMA foreign_keys = ON;

-- 1. 用户表
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '默认用户',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. 多端同步设备表
CREATE TABLE IF NOT EXISTS sync_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name   TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('web','windows','macos','linux','android')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. 统一无限层级节点表（物化路径 /root/<id1>/<id2>/，彻底取消笔记本概念）
CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  rank            TEXT NOT NULL,
  title           TEXT NOT NULL,
  node_type       TEXT NOT NULL CHECK (node_type IN ('folder','note','markdown','docx','xlsx','pdf')),
  icon            TEXT,
  yjs_state       BLOB,
  content_html    TEXT NOT NULL DEFAULT '',
  current_file_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  plain_text      TEXT NOT NULL DEFAULT '',
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_user_path ON nodes (user_id, path);
CREATE INDEX IF NOT EXISTS idx_nodes_parent_rank ON nodes (user_id, parent_id, rank) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes (user_id, updated_at DESC);

-- 4. Office/PDF 文件资产与版本历史表
CREATE TABLE IF NOT EXISTS node_files (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  preview_pdf_key TEXT,
  preview_status  TEXT NOT NULL DEFAULT 'pending' CHECK (preview_status IN ('pending','ready','failed')),
  source_device   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (node_id, version)
);

CREATE INDEX IF NOT EXISTS idx_node_files_sha256 ON node_files (sha256);
CREATE INDEX IF NOT EXISTS idx_node_files_node_ver ON node_files (node_id, version DESC);

-- 5. OneNote 一次性迁移任务与断点续传表
CREATE TABLE IF NOT EXISTS import_jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL CHECK (source_type IN ('graph_api','onepkg_local')),
  target_node_id  TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed')),
  total_pages     INTEGER NOT NULL DEFAULT 0,
  imported_pages  INTEGER NOT NULL DEFAULT 0,
  failed_pages    INTEGER NOT NULL DEFAULT 0,
  cursor_state    TEXT NOT NULL DEFAULT '{}',
  error_log       TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

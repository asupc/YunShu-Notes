import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
fs.mkdirSync(config.filesDir, { recursive: true });
fs.mkdirSync(config.previewsDir, { recursive: true });

export const db: Database.Database = new Database(config.sqlitePath);

// 开启 WAL 模式与外键约束，提升多端并发读写性能
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '默认用户',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name   TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('web','windows','macos','linux','android')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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
`;

db.exec(INIT_SQL);

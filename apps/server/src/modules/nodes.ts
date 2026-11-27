import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type NodeMeta, type NodeType, type WorkspaceSection, type NoteVersionChangeSource, type NoteVersionDetail, type NoteVersionSummary, rankBetween } from '@yunshu/shared';
import { db } from '../db';
import { requireAuth } from './auth';

interface NodeRow {
  id: string;
  parent_id: string | null;
  path: string;
  rank: string;
  title: string;
  node_type: NodeType;
  section?: WorkspaceSection;
  icon: string | null;
  current_file_id: string | null;
  current_version: number;
  is_pinned: number;
  is_deleted: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  content_html?: string;
  plain_text?: string;
}

function mapNode(row: NodeRow): NodeMeta {
  return {
    id: row.id,
    parentId: row.parent_id,
    path: row.path,
    rank: row.rank,
    title: row.title,
    nodeType: row.node_type,
    section: row.section === 'docs' ? 'docs' : 'notes',
    icon: row.icon,
    currentFileId: row.current_file_id,
    currentVersion: row.current_version,
    isPinned: Boolean(row.is_pinned),
    isDeleted: Boolean(row.is_deleted),
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface NoteVersionRow {
  id: string;
  node_id: string;
  version: number;
  title: string;
  content_html: string;
  plain_text: string;
  change_source: NoteVersionChangeSource;
  created_at: string;
}

function mapNoteVersionSummary(row: NoteVersionRow): NoteVersionSummary {
  const cleaned = (row.plain_text || '').replace(/\s+/g, ' ').trim();
  return {
    id: row.id,
    nodeId: row.node_id,
    version: row.version,
    title: row.title,
    plainTextPreview: cleaned.slice(0, 120),
    charCount: (row.plain_text || '').replace(/\s+/g, '').length,
    changeSource: row.change_source,
    createdAt: row.created_at,
  };
}

function mapNoteVersionDetail(row: NoteVersionRow): NoteVersionDetail {
  return {
    ...mapNoteVersionSummary(row),
    contentHtml: row.content_html ?? '',
    plainText: row.plain_text ?? '',
  };
}

function extractNoteContentSignature(html: string): string {
  const trimmed = (html || '').trim();
  if (!trimmed) return '';
  // 剥离画布文本块的坐标、宽高与层级属性，仅比较实际文本/图片/表格内容
  if (trimmed.includes('data-yunshu-canvas="1"')) {
    const blocks: string[] = [];
    const regex = /<section\b[^>]*data-canvas-block="1"[^>]*>([\s\S]*?)<\/section>/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(trimmed)) !== null) {
      const inner = (m[1] || '').trim();
      const hasMedia = /<img\b|<table\b/i.test(inner);
      const plain = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, '').trim();
      if (hasMedia || plain.length > 0) {
        blocks.push(inner);
      }
    }
    return blocks.join('\n---\n');
  }
  return trimmed;
}

function pruneExpiredNoteVersions(userId: string): void {
  db.prepare(
    `DELETE FROM note_versions
     WHERE user_id = ? AND created_at < datetime('now', '-30 days')`
  ).run(userId);
}

function recordNoteVersion(
  nodeId: string,
  userId: string,
  title: string,
  contentHtml: string,
  plainText: string,
  changeSource: NoteVersionChangeSource
): number | null {
  pruneExpiredNoteVersions(userId);

  const latest = db
    .prepare(
      `SELECT id, version, title, content_html, change_source,
              (strftime('%s', 'now') - strftime('%s', created_at)) AS age_sec
       FROM note_versions
       WHERE node_id = ? AND user_id = ?
       ORDER BY version DESC
       LIMIT 1`
    )
    .get(nodeId, userId) as
    | {
        id: string;
        version: number;
        title: string;
        content_html: string;
        change_source: NoteVersionChangeSource;
        age_sec: number;
      }
    | undefined;

  if (
    changeSource !== 'before_restore' &&
    latest &&
    latest.title === title &&
    (latest.content_html === contentHtml ||
      extractNoteContentSignature(latest.content_html) === extractNoteContentSignature(contentHtml))
  ) {
    // 仅文本框位置/大小变化而内容未变时，不生成新版本，仅原地刷新最新布局
    if (latest.content_html !== contentHtml) {
      db.prepare('UPDATE note_versions SET content_html = ?, plain_text = ? WHERE id = ?').run(
        contentHtml,
        plainText,
        latest.id
      );
    }
    return latest.version;
  }

  // 自动同步 60 秒内连续保存合并到同一版本快照，避免碎片刷屏
  if (
    changeSource === 'auto' &&
    latest &&
    latest.change_source === 'auto' &&
    typeof latest.age_sec === 'number' &&
    latest.age_sec >= 0 &&
    latest.age_sec < 60
  ) {
    db.prepare(
      `UPDATE note_versions
       SET title = ?, content_html = ?, plain_text = ?, created_at = datetime('now')
       WHERE id = ?`
    ).run(title, contentHtml, plainText, latest.id);
    return latest.version;
  }

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max_ver FROM note_versions WHERE node_id = ? AND user_id = ?')
    .get(nodeId, userId) as { max_ver: number };
  const nextVersion = (maxRow?.max_ver ?? 0) + 1;

  db.prepare(
    `INSERT INTO note_versions (id, node_id, user_id, version, title, content_html, plain_text, change_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), nodeId, userId, nextVersion, title, contentHtml, plainText, changeSource);

  db.prepare('UPDATE nodes SET current_version = ? WHERE id = ? AND user_id = ?').run(nextVersion, nodeId, userId);
  return nextVersion;
}


export async function registerNodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/nodes/tree', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { deleted } = req.query as { deleted?: string };
    const isDeleted = deleted === 'true' ? 1 : 0;
    const orderSql = isDeleted ? 'ORDER BY deleted_at DESC, updated_at DESC' : 'ORDER BY rank ASC';
    const rows = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, section, icon,
                current_file_id, current_version, is_pinned, is_deleted, deleted_at, created_at, updated_at
         FROM nodes
         WHERE user_id = ? AND is_deleted = ?
         ${orderSql}`
      )
      .all(auth.userId, isDeleted) as NodeRow[];
    return {
      nodes: rows.map(mapNode),
      serverTime: new Date().toISOString(),
    };
  });

  const createSchema = z.object({
    parentId: z.string().uuid().nullable().optional(),
    title: z.string().min(1, '标题不能为空').max(200),
    nodeType: z.enum(['folder', 'note', 'markdown', 'docx', 'xlsx', 'pdf']),
    section: z.enum(['notes', 'docs']).optional(),
    prevRank: z.string().nullable().optional(),
    nextRank: z.string().nullable().optional(),
    contentHtml: z.string().optional(),
    plainText: z.string().optional(),
  });

  app.post('/api/v1/nodes', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { parentId = null, title, nodeType, section: reqSection, prevRank, nextRank, contentHtml = '', plainText = '' } = parsed.data;

    let parentPath = '/root/';
    let resolvedSection: WorkspaceSection =
      reqSection ?? (nodeType === 'docx' || nodeType === 'xlsx' || nodeType === 'pdf' ? 'docs' : 'notes');
    if (parentId) {
      const parent = db
        .prepare('SELECT path, section FROM nodes WHERE id = ? AND user_id = ?')
        .get(parentId, auth.userId) as { path: string; section: WorkspaceSection } | undefined;
      if (!parent) return reply.code(404).send({ error: '父节点不存在' });
      parentPath = parent.path;
      resolvedSection = reqSection ?? (parent.section === 'docs' ? 'docs' : 'notes');
    }

    const newId = crypto.randomUUID();
    const newPath = `${parentPath}${newId}/`;
    let rank: string;
    if (prevRank !== undefined || nextRank !== undefined) {
      rank = rankBetween(prevRank, nextRank);
    } else {
      const lastSibling = (parentId
        ? db
            .prepare(
              'SELECT rank FROM nodes WHERE user_id = ? AND parent_id = ? AND is_deleted = 0 ORDER BY rank DESC LIMIT 1'
            )
            .get(auth.userId, parentId)
        : db
            .prepare(
              'SELECT rank FROM nodes WHERE user_id = ? AND parent_id IS NULL AND is_deleted = 0 ORDER BY rank DESC LIMIT 1'
            )
            .get(auth.userId)) as { rank: string } | undefined;
      rank = rankBetween(lastSibling?.rank ?? null, null);
    }

    db.prepare(
      `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type, section, content_html, plain_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId, auth.userId, parentId, newPath, rank, title, nodeType, resolvedSection, contentHtml, plainText);

    const created = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, section, icon,
                current_file_id, current_version, is_pinned, is_deleted, created_at, updated_at
         FROM nodes WHERE id = ?`
      )
      .get(newId) as NodeRow;

    return { node: mapNode(created) };
  });

  app.get('/api/v1/nodes/:id', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const row = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, section, icon,
                current_file_id, current_version, is_pinned, is_deleted,
                content_html, plain_text, created_at, updated_at
         FROM nodes WHERE id = ? AND user_id = ?`
      )
      .get(id, auth.userId) as NodeRow | undefined;
    if (!row) return reply.code(404).send({ error: '节点不存在' });
    return {
      node: mapNode(row),
      contentHtml: row.content_html ?? '',
      plainText: row.plain_text ?? '',
    };
  });

  const updateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    contentHtml: z.string().optional(),
    plainText: z.string().optional(),
    isPinned: z.boolean().optional(),
    saveVersion: z.enum(['auto', 'manual']).optional(),
  });

  app.patch('/api/v1/nodes/:id', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '更新参数错误' });

    const { title, contentHtml, plainText, isPinned, saveVersion } = parsed.data;
    const existing = db
      .prepare(
        `SELECT id, title, node_type, content_html, plain_text
         FROM nodes WHERE id = ? AND user_id = ?`
      )
      .get(id, auth.userId) as
      | { id: string; title: string; node_type: NodeType; content_html: string; plain_text: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: '节点不存在' });

    const nextTitle = title ?? existing.title;
    const nextHtml = contentHtml ?? existing.content_html;
    const nextPlain = plainText ?? existing.plain_text;
    const isNoteNode = existing.node_type === 'note' || existing.node_type === 'markdown';

    db.transaction(() => {
      // 首次同步已有内容的旧笔记前，先留存修改前的基线快照以便回滚
      if (isNoteNode && (contentHtml !== undefined || saveVersion !== undefined)) {
        const verCount = db
          .prepare('SELECT COUNT(1) AS cnt FROM note_versions WHERE node_id = ? AND user_id = ?')
          .get(id, auth.userId) as { cnt: number };
        if (
          verCount.cnt === 0 &&
          existing.content_html.trim() !== '' &&
          (existing.content_html !== nextHtml || existing.title !== nextTitle)
        ) {
          recordNoteVersion(id, auth.userId, existing.title, existing.content_html, existing.plain_text, 'auto');
        }
      }

      db.prepare(
        `UPDATE nodes
         SET title = COALESCE(?, title),
             content_html = COALESCE(?, content_html),
             plain_text = COALESCE(?, plain_text),
             is_pinned = COALESCE(?, is_pinned),
             updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      ).run(
        title ?? null,
        contentHtml ?? null,
        plainText ?? null,
        isPinned === undefined ? null : isPinned ? 1 : 0,
        id,
        auth.userId
      );

      if (isNoteNode && (contentHtml !== undefined || saveVersion !== undefined)) {
        recordNoteVersion(id, auth.userId, nextTitle, nextHtml, nextPlain, saveVersion ?? 'auto');
      }
    })();

    const updated = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, section, icon,
                current_file_id, current_version, is_pinned, is_deleted, created_at, updated_at
         FROM nodes WHERE id = ?`
      )
      .get(id) as NodeRow;
    return { node: mapNode(updated) };
  });

  // 笔记历史版本列表（仅保留最近 30 天）
  app.get('/api/v1/nodes/:id/note-versions', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const node = db
      .prepare('SELECT id FROM nodes WHERE id = ? AND user_id = ?')
      .get(id, auth.userId) as { id: string } | undefined;
    if (!node) return reply.code(404).send({ error: '节点不存在' });

    pruneExpiredNoteVersions(auth.userId);
    const rows = db
      .prepare(
        `SELECT id, node_id, version, title, content_html, plain_text, change_source, created_at
         FROM note_versions
         WHERE node_id = ? AND user_id = ? AND created_at >= datetime('now', '-30 days')
         ORDER BY version DESC`
      )
      .all(id, auth.userId) as NoteVersionRow[];

    return {
      retentionDays: 30,
      versions: rows.map(mapNoteVersionSummary),
    };
  });

  // 查看单个历史版本完整内容
  app.get('/api/v1/nodes/:id/note-versions/:versionId', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id, versionId } = req.params as { id: string; versionId: string };
    const row = db
      .prepare(
        `SELECT id, node_id, version, title, content_html, plain_text, change_source, created_at
         FROM note_versions
         WHERE id = ? AND node_id = ? AND user_id = ? AND created_at >= datetime('now', '-30 days')`
      )
      .get(versionId, id, auth.userId) as NoteVersionRow | undefined;
    if (!row) return reply.code(404).send({ error: '历史版本不存在或已超过30天保留期' });
    return { version: mapNoteVersionDetail(row) };
  });

  // 恢复到指定历史版本（恢复前自动备份当前内容）
  app.post('/api/v1/nodes/:id/note-versions/:versionId/restore', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id, versionId } = req.params as { id: string; versionId: string };

    const target = db
      .prepare(
        `SELECT id, node_id, version, title, content_html, plain_text, change_source, created_at
         FROM note_versions
         WHERE id = ? AND node_id = ? AND user_id = ? AND created_at >= datetime('now', '-30 days')`
      )
      .get(versionId, id, auth.userId) as NoteVersionRow | undefined;
    if (!target) return reply.code(404).send({ error: '历史版本不存在或已超过30天保留期' });

    const current = db
      .prepare('SELECT id, title, content_html, plain_text FROM nodes WHERE id = ? AND user_id = ?')
      .get(id, auth.userId) as
      | { id: string; title: string; content_html: string; plain_text: string }
      | undefined;
    if (!current) return reply.code(404).send({ error: '节点不存在' });

    db.transaction(() => {
      if (current.content_html !== target.content_html || current.title !== target.title) {
        recordNoteVersion(id, auth.userId, current.title, current.content_html, current.plain_text, 'before_restore');
      }
      db.prepare(
        `UPDATE nodes
         SET title = ?, content_html = ?, plain_text = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      ).run(target.title, target.content_html, target.plain_text, id, auth.userId);

      recordNoteVersion(id, auth.userId, target.title, target.content_html, target.plain_text, 'manual');
    })();

    const updated = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, section, icon,
                current_file_id, current_version, is_pinned, is_deleted, created_at, updated_at
         FROM nodes WHERE id = ?`
      )
      .get(id) as NodeRow;

    return {
      node: mapNode(updated),
      contentHtml: target.content_html,
      plainText: target.plain_text,
      restoredFromVersion: target.version,
    };
  });

  const moveSchema = z.object({
    newParentId: z.string().min(1).nullable(),
    prevRank: z.string().nullable().optional(),
    nextRank: z.string().nullable().optional(),
  });

  // SQLite 事务原子移动整棵子树（物化路径前缀替换 + 防循环引用）
  app.patch('/api/v1/nodes/:id/move', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '移动参数错误' });

    const { newParentId, prevRank, nextRank } = parsed.data;
    const newRank = rankBetween(prevRank ?? null, nextRank ?? null);

    try {
      const tx = db.transaction(() => {
        const cur = db
          .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
          .get(id, auth.userId) as { path: string } | undefined;
        if (!cur) throw new Error('NOT_FOUND');

        let newParentPath = '/root/';
        if (newParentId) {
          const target = db
            .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
            .get(newParentId, auth.userId) as { path: string } | undefined;
          if (!target) throw new Error('PARENT_NOT_FOUND');
          if (target.path.startsWith(cur.path)) throw new Error('CYCLE');
          newParentPath = target.path;
        }

        const newPrefix = `${newParentPath}${id}/`;
        const oldPath = cur.path;
        const oldLen = oldPath.length;

        db.prepare(
          `UPDATE nodes
           SET path = ? || substr(path, ?),
               parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
               rank = CASE WHEN id = ? THEN ? ELSE rank END,
               updated_at = datetime('now')
           WHERE user_id = ? AND path LIKE ?`
        ).run(newPrefix, oldLen + 1, id, newParentId, id, newRank, auth.userId, `${oldPath}%`);
      });

      tx();
      return { ok: true, rank: newRank };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'NOT_FOUND') return reply.code(404).send({ error: '待移动节点不存在' });
      if (msg === 'PARENT_NOT_FOUND') return reply.code(404).send({ error: '目标父节点不存在' });
      if (msg === 'CYCLE') return reply.code(400).send({ error: '不能将目录移动到自身或子目录下' });
      return reply.code(500).send({ error: '移动节点失败' });
    }
  });

  app.delete('/api/v1/nodes/:id', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const cur = db
      .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
      .get(id, auth.userId) as { path: string } | undefined;
    if (!cur) return reply.code(404).send({ error: '节点不存在' });

    db.prepare(
      `UPDATE nodes SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND path LIKE ?`
    ).run(auth.userId, `${cur.path}%`);
    return { ok: true };
  });

  app.post('/api/v1/nodes/:id/restore', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const cur = db
      .prepare('SELECT id, parent_id, path FROM nodes WHERE id = ? AND user_id = ?')
      .get(id, auth.userId) as { id: string; parent_id: string | null; path: string } | undefined;
    if (!cur) return reply.code(404).send({ error: '节点不存在' });

    let movedToRoot = false;
    db.transaction(() => {
      let needMoveToRoot = false;
      if (cur.parent_id) {
        const parent = db
          .prepare('SELECT is_deleted FROM nodes WHERE id = ? AND user_id = ?')
          .get(cur.parent_id, auth.userId) as { is_deleted: number } | undefined;
        if (!parent || parent.is_deleted === 1) {
          needMoveToRoot = true;
        }
      }

      if (needMoveToRoot) {
        movedToRoot = true;
        const newPrefix = `/root/${cur.id}/`;
        const oldLen = cur.path.length;
        db.prepare(
          `UPDATE nodes
           SET path = ? || substr(path, ?),
               parent_id = CASE WHEN id = ? THEN NULL ELSE parent_id END,
               is_deleted = 0,
               deleted_at = NULL,
               updated_at = datetime('now')
           WHERE user_id = ? AND path LIKE ?`
        ).run(newPrefix, oldLen + 1, cur.id, auth.userId, `${cur.path}%`);
      } else {
        db.prepare(
          `UPDATE nodes SET is_deleted = 0, deleted_at = NULL, updated_at = datetime('now')
           WHERE user_id = ? AND path LIKE ?`
        ).run(auth.userId, `${cur.path}%`);
      }
    })();

    return { ok: true, movedToRoot };
  });

  // 永久删除单个回收站节点及其子树
  app.delete('/api/v1/nodes/:id/permanent', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const cur = db
      .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ? AND is_deleted = 1')
      .get(id, auth.userId) as { path: string } | undefined;
    if (!cur) return reply.code(404).send({ error: '回收站中未找到该节点' });

    const info = db
      .prepare('DELETE FROM nodes WHERE user_id = ? AND is_deleted = 1 AND path LIKE ?')
      .run(auth.userId, `${cur.path}%`);
    return { ok: true, deletedCount: info.changes };
  });

  // 一键清空回收站
  app.delete('/api/v1/trash', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const info = db
      .prepare('DELETE FROM nodes WHERE user_id = ? AND is_deleted = 1')
      .run(auth.userId);
    return { ok: true, deletedCount: info.changes };
  });

  // 全文检索（按路径切分精准查祖先面包屑，避免全表扫描）
  app.get('/api/v1/search', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { q = '', types } = req.query as { q?: string; types?: string };
    const keyword = q.trim();
    if (!keyword) return { hits: [] };

    const typeList = types
      ? types.split(',').filter((t) => ['folder', 'note', 'markdown', 'docx', 'xlsx', 'pdf'].includes(t))
      : [];

    const pattern = `%${keyword}%`;
    const typeClause =
      typeList.length > 0 ? `AND node_type IN (${typeList.map(() => '?').join(',')})` : '';

    const rows = db
      .prepare(
        `SELECT id, path, title, node_type, plain_text, updated_at
         FROM nodes
         WHERE user_id = ? AND is_deleted = 0
           AND (title LIKE ? OR plain_text LIKE ?)
           ${typeClause}
         ORDER BY (CASE WHEN title LIKE ? THEN 0 ELSE 1 END), updated_at DESC
         LIMIT 30`
      )
      .all(auth.userId, pattern, pattern, ...typeList, pattern) as Array<{
      id: string;
      path: string;
      title: string;
      node_type: NodeType;
      plain_text: string;
      updated_at: string;
    }>;

    // 仅收集命中路径上的祖先 ID 一次主键查询
    const ancestorIds = new Set<string>();
    for (const r of rows) {
      const parts = r.path.split('/').filter((seg) => seg && seg !== 'root' && seg !== r.id);
      for (const pid of parts) ancestorIds.add(pid);
    }

    const titleMap = new Map<string, string>();
    if (ancestorIds.size > 0) {
      const ids = Array.from(ancestorIds);
      const ancRows = db
        .prepare(`SELECT id, title FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as Array<{ id: string; title: string }>;
      for (const a of ancRows) titleMap.set(a.id, a.title);
    }

    const hits = rows.map((r) => {
      const lower = r.plain_text.toLowerCase();
      const idx = lower.indexOf(keyword.toLowerCase());
      const snippet =
        idx >= 0
          ? r.plain_text.slice(Math.max(0, idx - 24), idx + keyword.length + 56).replace(/\s+/g, ' ')
          : r.plain_text.slice(0, 80).replace(/\s+/g, ' ');
      const breadcrumb = r.path
        .split('/')
        .filter((seg) => seg && seg !== 'root' && seg !== r.id)
        .map((pid) => titleMap.get(pid))
        .filter((t): t is string => Boolean(t));
      return {
        id: r.id,
        title: r.title,
        nodeType: r.node_type,
        breadcrumb,
        snippet,
        updatedAt: r.updated_at,
      };
    });

    return { hits };
  });
}

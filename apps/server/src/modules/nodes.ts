import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type NodeMeta, type NodeType, rankBetween } from '@yunshu/shared';
import { db } from '../db';
import { requireAuth } from './auth';

interface NodeRow {
  id: string;
  parent_id: string | null;
  path: string;
  rank: string;
  title: string;
  node_type: NodeType;
  icon: string | null;
  current_file_id: string | null;
  current_version: number;
  is_pinned: number;
  is_deleted: number;
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
    icon: row.icon,
    currentFileId: row.current_file_id,
    currentVersion: row.current_version,
    isPinned: Boolean(row.is_pinned),
    isDeleted: Boolean(row.is_deleted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerNodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/nodes/tree', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { deleted } = req.query as { deleted?: string };
    const isDeleted = deleted === 'true' ? 1 : 0;
    const rows = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, icon,
                current_file_id, current_version, is_pinned, is_deleted, created_at, updated_at
         FROM nodes
         WHERE user_id = ? AND is_deleted = ?
         ORDER BY rank ASC`
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
    const { parentId = null, title, nodeType, prevRank, nextRank, contentHtml = '', plainText = '' } = parsed.data;

    let parentPath = '/root/';
    if (parentId) {
      const parent = db
        .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
        .get(parentId, auth.userId) as { path: string } | undefined;
      if (!parent) return reply.code(404).send({ error: '父节点不存在' });
      parentPath = parent.path;
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
      `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type, content_html, plain_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId, auth.userId, parentId, newPath, rank, title, nodeType, contentHtml, plainText);

    const created = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, icon,
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
        `SELECT id, parent_id, path, rank, title, node_type, icon,
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
  });

  app.patch('/api/v1/nodes/:id', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '更新参数错误' });

    const { title, contentHtml, plainText, isPinned } = parsed.data;
    const info = db
      .prepare(
        `UPDATE nodes
         SET title = COALESCE(?, title),
             content_html = COALESCE(?, content_html),
             plain_text = COALESCE(?, plain_text),
             is_pinned = COALESCE(?, is_pinned),
             updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      )
      .run(
        title ?? null,
        contentHtml ?? null,
        plainText ?? null,
        isPinned === undefined ? null : isPinned ? 1 : 0,
        id,
        auth.userId
      );

    if (info.changes === 0) return reply.code(404).send({ error: '节点不存在' });
    const updated = db
      .prepare(
        `SELECT id, parent_id, path, rank, title, node_type, icon,
                current_file_id, current_version, is_pinned, is_deleted, created_at, updated_at
         FROM nodes WHERE id = ?`
      )
      .get(id) as NodeRow;
    return { node: mapNode(updated) };
  });

  const moveSchema = z.object({
    newParentId: z.string().uuid().nullable(),
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
      .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
      .get(id, auth.userId) as { path: string } | undefined;
    if (!cur) return reply.code(404).send({ error: '节点不存在' });

    db.prepare(
      `UPDATE nodes SET is_deleted = 0, deleted_at = NULL, updated_at = datetime('now')
       WHERE user_id = ? AND path LIKE ?`
    ).run(auth.userId, `${cur.path}%`);
    return { ok: true };
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

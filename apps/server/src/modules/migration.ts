import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rankBetween } from '@yunshu/shared';
import { db } from '../db';
import { requireAuth } from './auth';

function sanitizeOneNoteHtml(rawHtml: string): { cleanHtml: string; plainText: string } {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let html = bodyMatch ? bodyMatch[1] : rawHtml;
  html = html.replace(/style="[^"]*position\s*:\s*absolute[^"]*"/gi, '');
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const plainText = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { cleanHtml: html.trim(), plainText };
}

async function fetchGraphWithBackoff(url: string, accessToken: string): Promise<Response> {
  const delays = [30_000, 60_000, 120_000, 300_000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 429 && res.status !== 503) return res;
    const retryAfterSec = Number(res.headers.get('Retry-After') ?? '0');
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : delays[Math.min(attempt, delays.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error('Microsoft Graph API 持续触发限流（429），已暂停等待稍后重试');
}

const activePausedJobs = new Set<string>();

export async function registerMigrationRoutes(app: FastifyInstance): Promise<void> {
  const batchSchema = z.object({
    targetNodeId: z.string().uuid().nullable().optional(),
    rootTitle: z.string().min(1).default('OneNote 历史归档'),
    pages: z.array(
      z.object({
        title: z.string().min(1),
        folderPath: z.array(z.string()).default([]),
        level: z.number().int().min(0).max(5).default(0),
        htmlContent: z.string().default(''),
      })
    ),
  });

  app.post('/api/v1/migrations/onepkg-batch', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '导入数据格式不正确' });

    const { targetNodeId = null, rootTitle, pages } = parsed.data;
    let basePath = '/root/';
    if (targetNodeId) {
      const p = db
        .prepare('SELECT path FROM nodes WHERE id = ? AND user_id = ?')
        .get(targetNodeId, auth.userId) as { path: string } | undefined;
      if (p) basePath = p.path;
    }

    const archiveId = crypto.randomUUID();
    const archivePath = `${basePath}${archiveId}/`;
    const jobId = crypto.randomUUID();

    const insertTx = db.transaction(() => {
      db.prepare(
        `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type)
         VALUES (?, ?, ?, ?, ?, ?, 'folder')`
      ).run(archiveId, auth.userId, targetNodeId, archivePath, rankBetween(null, null), rootTitle);

      db.prepare(
        `INSERT INTO import_jobs (id, user_id, source_type, target_node_id, status, total_pages, imported_pages)
         VALUES (?, ?, 'onepkg_local', ?, 'running', ?, 0)`
      ).run(jobId, auth.userId, archiveId, pages.length);

      const folderCache = new Map<string, { id: string; path: string }>();
      folderCache.set('', { id: archiveId, path: archivePath });

      const ensureFolder = (segments: string[]): { id: string; path: string } => {
        let key = '';
        let parent: { id: string; path: string } = { id: archiveId, path: archivePath };
        for (const seg of segments) {
          const nextKey = key ? `${key}/${seg}` : seg;
          const cached = folderCache.get(nextKey);
          if (cached) {
            parent = cached;
          } else {
            const fid = crypto.randomUUID();
            const fpath = `${parent.path}${fid}/`;
            db.prepare(
              `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type)
               VALUES (?, ?, ?, ?, ?, ?, 'folder')`
            ).run(fid, auth.userId, parent.id, fpath, rankBetween(null, null), seg);
            parent = { id: fid, path: fpath };
            folderCache.set(nextKey, parent);
          }
          key = nextKey;
        }
        return parent;
      };

      let imported = 0;
      let lastRank: string | null = null;
      const levelStack: Array<{ level: number; id: string; path: string }> = [];

      for (const page of pages) {
        const folder = ensureFolder(page.folderPath);
        let parentId = folder.id;
        let parentPath = folder.path;

        if (page.level > 0) {
          while (levelStack.length > 0 && levelStack[levelStack.length - 1].level >= page.level) {
            levelStack.pop();
          }
          if (levelStack.length > 0) {
            parentId = levelStack[levelStack.length - 1].id;
            parentPath = levelStack[levelStack.length - 1].path;
          }
        } else {
          levelStack.length = 0;
        }

        const nid = crypto.randomUUID();
        const npath = `${parentPath}${nid}/`;
        const { cleanHtml, plainText } = sanitizeOneNoteHtml(page.htmlContent);
        lastRank = rankBetween(lastRank, null);

        db.prepare(
          `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type, content_html, plain_text)
           VALUES (?, ?, ?, ?, ?, ?, 'note', ?, ?)`
        ).run(nid, auth.userId, parentId, npath, lastRank, page.title, cleanHtml, plainText);

        levelStack.push({ level: page.level, id: nid, path: npath });
        imported += 1;
      }

      db.prepare("UPDATE import_jobs SET status = 'done', imported_pages = ?, updated_at = datetime('now') WHERE id = ?").run(
        imported,
        jobId
      );
      return imported;
    });

    const importedPages = insertTx();
    return { ok: true, jobId, archiveNodeId: archiveId, importedPages };
  });

  const graphSchema = z.object({
    accessToken: z.string().min(20, '请提供有效的 Microsoft Graph 访问令牌'),
    targetNodeId: z.string().uuid().nullable().optional(),
  });

  app.post('/api/v1/migrations/graph', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const parsed = graphSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });

    const { accessToken, targetNodeId = null } = parsed.data;
    const jobId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO import_jobs (id, user_id, source_type, target_node_id, status)
       VALUES (?, ?, 'graph_api', ?, 'running')`
    ).run(jobId, auth.userId, targetNodeId);

    void (async () => {
      const errors: Array<{ pageTitle: string; reason: string; retryable: boolean }> = [];
      let imported = 0;
      try {
        const nbRes = await fetchGraphWithBackoff('https://graph.microsoft.com/v1.0/me/onenote/notebooks', accessToken);
        if (!nbRes.ok) throw new Error(`读取 OneNote 笔记本失败（HTTP ${nbRes.status}）`);
        const nbData = (await nbRes.json()) as { value?: Array<{ id: string; displayName: string }> };

        for (const nb of nbData.value ?? []) {
          if (activePausedJobs.has(jobId)) break;
          const secRes = await fetchGraphWithBackoff(
            `https://graph.microsoft.com/v1.0/me/onenote/notebooks/${nb.id}/sections`,
            accessToken
          );
          if (!secRes.ok) continue;
          const secData = (await secRes.json()) as { value?: Array<{ id: string; displayName: string }> };

          for (const sec of secData.value ?? []) {
            const pageRes = await fetchGraphWithBackoff(
              `https://graph.microsoft.com/v1.0/me/onenote/sections/${sec.id}/pages?$select=id,title,level`,
              accessToken
            );
            if (!pageRes.ok) continue;
            const pageData = (await pageRes.json()) as {
              value?: Array<{ id: string; title: string; level?: number }>;
            };
            const pages = pageData.value ?? [];
            db.prepare("UPDATE import_jobs SET total_pages = total_pages + ?, updated_at = datetime('now') WHERE id = ?").run(
              pages.length,
              jobId
            );

            for (const pg of pages) {
              if (activePausedJobs.has(jobId)) break;
              try {
                await new Promise((r) => setTimeout(r, 700));
                const contentRes = await fetchGraphWithBackoff(
                  `https://graph.microsoft.com/v1.0/me/onenote/pages/${pg.id}/content`,
                  accessToken
                );
                const rawHtml = contentRes.ok ? await contentRes.text() : '';
                const { cleanHtml, plainText } = sanitizeOneNoteHtml(rawHtml);
                const nid = crypto.randomUUID();
                const npath = `/root/${nid}/`;
                db.prepare(
                  `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type, content_html, plain_text)
                   VALUES (?, ?, ?, ?, ?, ?, 'note', ?, ?)`
                ).run(nid, auth.userId, targetNodeId, npath, rankBetween(null, null), `${nb.displayName} / ${pg.title}`, cleanHtml, plainText);
                imported += 1;
                db.prepare("UPDATE import_jobs SET imported_pages = ?, updated_at = datetime('now') WHERE id = ?").run(
                  imported,
                  jobId
                );
              } catch (err) {
                errors.push({
                  pageTitle: pg.title,
                  reason: err instanceof Error ? err.message : '未知错误',
                  retryable: true,
                });
              }
            }
          }
        }

        db.prepare(
          "UPDATE import_jobs SET status = ?, failed_pages = ?, error_log = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(activePausedJobs.has(jobId) ? 'paused' : 'done', errors.length, JSON.stringify(errors), jobId);
      } catch (err) {
        errors.push({
          pageTitle: '全局连接',
          reason: err instanceof Error ? err.message : '未知异常',
          retryable: true,
        });
        db.prepare(
          "UPDATE import_jobs SET status = 'failed', error_log = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(errors), jobId);
      } finally {
        activePausedJobs.delete(jobId);
      }
    })();

    return { ok: true, jobId };
  });

  app.get('/api/v1/migrations/:jobId', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { jobId } = req.params as { jobId: string };
    const job = db
      .prepare('SELECT * FROM import_jobs WHERE id = ? AND user_id = ?')
      .get(jobId, auth.userId) as
      | {
          id: string;
          source_type: string;
          target_node_id: string | null;
          status: string;
          total_pages: number;
          imported_pages: number;
          failed_pages: number;
          error_log: string;
          updated_at: string;
        }
      | undefined;

    if (!job) return reply.code(404).send({ error: '迁移任务不存在' });
    return {
      job: {
        id: job.id,
        sourceType: job.source_type,
        targetNodeId: job.target_node_id,
        status: job.status,
        totalPages: job.total_pages,
        importedPages: job.imported_pages,
        failedPages: job.failed_pages,
        errorLog: JSON.parse(job.error_log || '[]'),
        updatedAt: job.updated_at,
      },
    };
  });

  app.post('/api/v1/migrations/:jobId/pause', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { jobId } = req.params as { jobId: string };
    activePausedJobs.add(jobId);
    db.prepare("UPDATE import_jobs SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(
      jobId,
      auth.userId
    );
    return { ok: true };
  });
}

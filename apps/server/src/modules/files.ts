import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rankBetween } from '@yunshu/shared';
import { db } from '../db';
import { enqueuePreviewTask } from '../previewQueue';
import {
  buildSignedDownloadUrl,
  buildSignedUploadUrl,
  readStorageFile,
  verifyStorageToken,
  writeStorageFile,
} from '../storage';
import { requireAuth } from './auth';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // 允许二进制流直传至本地磁盘（最大 200 MB）
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) => {
    done(null, body);
  });

  // 0. 本地磁盘二进制上传与下载端点（通过 HMAC 短时签名校验，无需 MinIO/S3）
  app.put('/api/v1/files/blob', async (req, reply) => {
    const { key = '', token = '' } = req.query as { key?: string; token?: string };
    if (!key || !verifyStorageToken(key, 'put', token)) {
      return reply.code(403).send({ error: '上传签名无效或已过期' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    await writeStorageFile(key, buf);
    return { ok: true, size: buf.length };
  });

  app.get('/api/v1/files/blob', async (req, reply) => {
    const { key = '', token = '' } = req.query as { key?: string; token?: string };
    if (!key || !verifyStorageToken(key, 'get', token)) {
      return reply.code(403).send({ error: '下载签名无效或已过期' });
    }
    try {
      const buf = await readStorageFile(key);
      const lower = key.toLowerCase();
      if (lower.endsWith('.pdf')) reply.type('application/pdf');
      else if (lower.endsWith('.xlsx')) reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      else if (lower.endsWith('.docx')) reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      else reply.type('application/octet-stream');
      return reply.send(buf);
    } catch {
      return reply.code(404).send({ error: '文件不存在' });
    }
  });

  // 1. 申请上传链接（支持 SHA-256 秒传去重）
  const presignSchema = z.object({
    nodeId: z.string().uuid(),
    fileName: z.string().min(1),
    fileSize: z.number().int().positive(),
    sha256: z.string().length(64),
    mimeType: z.string().min(1),
  });

  app.post('/api/v1/files/presign', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '上传参数不合法' });

    const { fileName, sha256 } = parsed.data;
    const existing = db
      .prepare('SELECT storage_key FROM node_files WHERE sha256 = ? LIMIT 1')
      .get(sha256) as { storage_key: string } | undefined;

    if (existing) {
      return {
        alreadyExists: true,
        storageKey: existing.storage_key,
        uploadUrl: null,
      };
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
    const storageKey = `files/${sha256}/${safeName}`;
    const uploadUrl = buildSignedUploadUrl(storageKey);
    return {
      alreadyExists: false,
      storageKey,
      uploadUrl,
    };
  });

  // 2. 提交文件新版本（乐观锁并发保护 + 自动创建冲突副本）
  const commitSchema = z.object({
    nodeId: z.string().uuid(),
    baseVersion: z.number().int().min(0),
    storageKey: z.string().min(1),
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    fileSize: z.number().int().positive(),
    sha256: z.string().length(64),
    deviceName: z.string().optional(),
    forceConflictCopy: z.boolean().optional(),
  });

  app.post('/api/v1/files/commit', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '提交版本参数不合法' });

    const {
      nodeId,
      baseVersion,
      storageKey,
      fileName,
      mimeType,
      fileSize,
      sha256,
      deviceName = '未知设备',
      forceConflictCopy = false,
    } = parsed.data;

    const node = db
      .prepare(
        'SELECT id, parent_id, path, title, node_type, current_version, current_file_id FROM nodes WHERE id = ? AND user_id = ?'
      )
      .get(nodeId, auth.userId) as
      | {
          id: string;
          parent_id: string | null;
          path: string;
          title: string;
          node_type: string;
          current_version: number;
          current_file_id: string | null;
        }
      | undefined;

    if (!node) return reply.code(404).send({ error: '目标文件节点不存在' });

    const isInitialUpload = !node.current_file_id && baseVersion === 0;
    const hasConflict = !isInitialUpload && node.current_version !== baseVersion;

    if (hasConflict && !forceConflictCopy) {
      const latestFile = db
        .prepare(
          'SELECT version, sha256, file_size, source_device, created_at FROM node_files WHERE node_id = ? ORDER BY version DESC LIMIT 1'
        )
        .get(nodeId);
      return reply.code(409).send({
        error: '检测到云端已有更新版本，请确认是否另存为冲突副本',
        conflict: true,
        remoteVersion: latestFile ?? null,
      });
    }

    let targetNodeId = nodeId;
    let nextVersion = isInitialUpload ? 1 : node.current_version + 1;

    if (hasConflict && forceConflictCopy) {
      const copyId = crypto.randomUUID();
      const parentPath = node.path.replace(new RegExp(`${node.id}/$`), '');
      const copyPath = `${parentPath}${copyId}/`;
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const copyTitle = `${node.title}（冲突副本 ${stamp}）`;

      db.prepare(
        `INSERT INTO nodes (id, user_id, parent_id, path, rank, title, node_type, current_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(copyId, auth.userId, node.parent_id, copyPath, rankBetween(null, null), copyTitle, node.node_type);
      targetNodeId = copyId;
      nextVersion = 1;
    }

    const fileId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO node_files (id, node_id, version, file_name, mime_type, file_size, sha256, storage_key, source_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fileId, targetNodeId, nextVersion, fileName, mimeType, fileSize, sha256, storageKey, deviceName);

    db.prepare(
      "UPDATE nodes SET current_file_id = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(fileId, nextVersion, targetNodeId);

    // 投递进程内异步预览与纯文本抽取队列（零 Redis 依赖）
    enqueuePreviewTask({ fileId, nodeId: targetNodeId, storageKey, fileName });

    return {
      ok: true,
      nodeId: targetNodeId,
      fileId,
      version: nextVersion,
      createdConflictCopy: hasConflict && forceConflictCopy,
    };
  });

  // 3. 获取文件下载与 PDF 预览签名 URL
  app.get('/api/v1/nodes/:id/file-urls', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const { version } = req.query as { version?: string };

    const ownerCheck = db.prepare('SELECT id FROM nodes WHERE id = ? AND user_id = ?').get(id, auth.userId);
    if (!ownerCheck) return reply.code(404).send({ error: '文件节点不存在' });

    const file = (version
      ? db
          .prepare(
            `SELECT version, file_name, mime_type, file_size, sha256, storage_key, preview_pdf_key, preview_status
             FROM node_files WHERE node_id = ? AND version = ?`
          )
          .get(id, Number(version))
      : db
          .prepare(
            `SELECT version, file_name, mime_type, file_size, sha256, storage_key, preview_pdf_key, preview_status
             FROM node_files WHERE node_id = ? ORDER BY version DESC LIMIT 1`
          )
          .get(id)) as
      | {
          version: number;
          file_name: string;
          mime_type: string;
          file_size: number;
          sha256: string;
          storage_key: string;
          preview_pdf_key: string | null;
          preview_status: string;
        }
      | undefined;

    if (!file) return reply.code(404).send({ error: '该节点尚未上传文件' });

    return {
      nodeId: id,
      version: file.version,
      fileName: file.file_name,
      mimeType: file.mime_type,
      fileSize: Number(file.file_size),
      sha256: file.sha256,
      downloadUrl: buildSignedDownloadUrl(file.storage_key),
      previewPdfUrl: file.preview_pdf_key ? buildSignedDownloadUrl(file.preview_pdf_key) : null,
      previewStatus: file.preview_status,
    };
  });

  // 4. 获取文件版本历史
  app.get('/api/v1/nodes/:id/versions', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id } = req.params as { id: string };

    const rows = db
      .prepare(
        `SELECT nf.id, nf.node_id, nf.version, nf.file_name, nf.mime_type, nf.file_size,
                nf.sha256, nf.preview_status, nf.source_device, nf.created_at
         FROM node_files nf
         INNER JOIN nodes n ON n.id = nf.node_id
         WHERE nf.node_id = ? AND n.user_id = ?
         ORDER BY nf.version DESC`
      )
      .all(id, auth.userId) as Array<{
      id: string;
      node_id: string;
      version: number;
      file_name: string;
      mime_type: string;
      file_size: number;
      sha256: string;
      preview_status: string;
      source_device: string | null;
      created_at: string;
    }>;

    return {
      versions: rows.map((r) => ({
        id: r.id,
        nodeId: r.node_id,
        version: r.version,
        fileName: r.file_name,
        mimeType: r.mime_type,
        fileSize: Number(r.file_size),
        sha256: r.sha256,
        previewStatus: r.preview_status,
        sourceDevice: r.source_device,
        createdAt: r.created_at,
      })),
    };
  });

  // 5. 恢复历史版本为最新版
  app.post('/api/v1/nodes/:id/versions/:version/restore', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    const { id, version } = req.params as { id: string; version: string };

    const oldFile = db
      .prepare(
        `SELECT nf.file_name, nf.mime_type, nf.file_size, nf.sha256, nf.storage_key,
                nf.preview_pdf_key, nf.preview_status
         FROM node_files nf
         INNER JOIN nodes n ON n.id = nf.node_id
         WHERE nf.node_id = ? AND n.user_id = ? AND nf.version = ?`
      )
      .get(id, auth.userId, Number(version)) as
      | {
          file_name: string;
          mime_type: string;
          file_size: number;
          sha256: string;
          storage_key: string;
          preview_pdf_key: string | null;
          preview_status: string;
        }
      | undefined;

    if (!oldFile) return reply.code(404).send({ error: '目标历史版本不存在' });

    const latest = db.prepare('SELECT current_version FROM nodes WHERE id = ?').get(id) as
      | { current_version: number }
      | undefined;
    const newVersion = (latest?.current_version ?? 1) + 1;
    const newFileId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO node_files (id, node_id, version, file_name, mime_type, file_size, sha256, storage_key, preview_pdf_key, preview_status, source_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newFileId,
      id,
      newVersion,
      oldFile.file_name,
      oldFile.mime_type,
      oldFile.file_size,
      oldFile.sha256,
      oldFile.storage_key,
      oldFile.preview_pdf_key,
      oldFile.preview_status,
      `从 v${version} 恢复`
    );

    db.prepare(
      "UPDATE nodes SET current_file_id = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newFileId, newVersion, id);

    return { ok: true, version: newVersion };
  });
}

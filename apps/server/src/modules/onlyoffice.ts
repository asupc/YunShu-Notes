import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config';
import { db } from '../db';
import { enqueuePreviewTask } from '../previewQueue';
import { buildSignedDownloadUrl, writeStorageFile } from '../storage';
import { requireAuth } from './auth';
import { onlyofficeManager } from './onlyofficeManager';

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function signCallbackToken(nodeId: string, userId: string, baseVersion: number, expires: number): string {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`oo-cb:${nodeId}:${userId}:${baseVersion}:${expires}`)
    .digest('hex');
}

function verifyCallbackToken(
  nodeId: string,
  userId: string,
  baseVersion: number,
  expires: number,
  token: string
): boolean {
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expected = signCallbackToken(nodeId, userId, baseVersion, expires);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function requestBase(req: FastifyRequest): string {
  const first = (value: string | string[] | undefined): string | undefined =>
    (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  return host ? `${proto}://${host}` : config.publicApiBase;
}

// 保存回调中的文件地址由 ONLYOFFICE 生成，可能带公网 Host（如 note.678120.cn:8888/onlyoffice/cache/...）。
// 服务端容器内统一改走 ONLYOFFICE 容器内网地址，避免 NAT 回环失败，或被前端 SPA 的 index.html 兜底成 200。
function resolveCallbackFileUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const pathname = url.pathname.startsWith('/onlyoffice/')
      ? url.pathname.slice('/onlyoffice'.length)
      : url.pathname;
    if (config.onlyofficeInternalUrl && pathname.startsWith('/cache/')) {
      return `${config.onlyofficeInternalUrl}${pathname}${url.search}`;
    }
  } catch {
    // 非绝对 URL 或解析失败时保持原样
  }
  return raw;
}

function resolveOnlyOfficeDocType(fileName: string): { fileType: string; documentType: 'word' | 'cell' | 'slide' } | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (['docx', 'doc', 'odt', 'rtf', 'txt'].includes(ext)) {
    return { fileType: ext, documentType: 'word' };
  }
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) {
    return { fileType: ext, documentType: 'cell' };
  }
  if (['pptx', 'ppt', 'odp'].includes(ext)) {
    return { fileType: ext, documentType: 'slide' };
  }
  return null;
}

export async function registerOnlyOfficeRoutes(app: FastifyInstance): Promise<void> {
  onlyofficeManager.setLogger({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });
  onlyofficeManager.startIdleWatcher();

  // 0. 查询 ONLYOFFICE 当前运行状态（不触发启动，用于文档查看模式）
  app.get('/api/v1/onlyoffice/status', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    return await onlyofficeManager.getStatus();
  });

  // 0.1 按需唤醒 ONLYOFFICE 容器（仅在用户主动点击「在线编辑」时调用）
  app.post('/api/v1/onlyoffice/wake', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    return await onlyofficeManager.wake();
  });

  // 0.2 在线编辑心跳续期（编辑期间每分钟上报，防止编辑中途被空闲休眠）
  app.post('/api/v1/onlyoffice/heartbeat', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    onlyofficeManager.markActivity();
    return { ok: true };
  });
  // 1. 获取指定文档的 ONLYOFFICE 在线编辑配置（含 JWT 签名）
  app.get('/api/v1/nodes/:id/onlyoffice/config', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;

    if (!config.onlyofficeUrl) {
      return { enabled: false };
    }

    const { id } = req.params as { id: string };
    const { theme = 'light' } = req.query as { theme?: string };

    const row = db
      .prepare(
        `SELECT n.id, n.title, nf.version, nf.file_name, nf.mime_type, nf.sha256, nf.storage_key
         FROM nodes n
         INNER JOIN node_files nf ON nf.id = n.current_file_id
         WHERE n.id = ? AND n.user_id = ?`
      )
      .get(id, auth.userId) as
      | {
          id: string;
          title: string;
          version: number;
          file_name: string;
          mime_type: string;
          sha256: string;
          storage_key: string;
        }
      | undefined;

    if (!row) return reply.code(404).send({ error: '该节点暂无可编辑的文件' });

    const docInfo = resolveOnlyOfficeDocType(row.file_name);
    if (!docInfo) {
      return { enabled: false, reason: '当前文件格式暂不支持 ONLYOFFICE 在线编辑' };
    }

    const userRow = db
      .prepare('SELECT display_name, email FROM users WHERE id = ?')
      .get(auth.userId) as { display_name: string; email: string } | undefined;

    // ONLYOFFICE 容器访问云树服务端时优先走容器内网地址，避免公网 NAT 回环问题
    const apiBaseForContainer = config.onlyofficeInternalApiBase || requestBase(req);
    const downloadUrl = buildSignedDownloadUrl(row.storage_key, apiBaseForContainer);
    const cbExpires = Date.now() + 6 * 3600 * 1000;
    const cbToken = signCallbackToken(row.id, auth.userId, row.version, cbExpires);
    const callbackUrl = `${apiBaseForContainer}/api/v1/onlyoffice/callback?nodeId=${encodeURIComponent(
      row.id
    )}&userId=${encodeURIComponent(auth.userId)}&baseVersion=${row.version}&expires=${cbExpires}&token=${cbToken}`;

    // document.key 随版本变化，确保刷新后总是加载最新内容
    const docKey = `${row.id.replace(/[^a-zA-Z0-9_-]/g, '')}_v${row.version}_${row.sha256.slice(0, 10)}`;

    const editorConfig: Record<string, unknown> = {
      documentType: docInfo.documentType,
      width: '100%',
      height: '100%',
      document: {
        fileType: docInfo.fileType,
        key: docKey,
        title: row.file_name,
        url: downloadUrl,
        permissions: {
          edit: true,
          download: true,
          print: true,
          review: true,
          comment: true,
        },
      },
      editorConfig: {
        mode: 'edit',
        lang: 'zh-CN',
        callbackUrl,
        user: {
          id: auth.userId,
          name: userRow?.display_name || userRow?.email || '云树用户',
        },
        customization: {
          autosave: true,
          forcesave: true,
          compactHeader: true,
          uiTheme: theme === 'dark' ? 'theme-contrast-dark' : 'theme-classic-light',
        },
      },
    };

    if (config.onlyofficeJwtSecret) {
      editorConfig.token = signHs256Jwt(editorConfig, config.onlyofficeJwtSecret);
    }

    return {
      enabled: true,
      onDemand: config.onlyofficeOnDemand,
      idleMinutes: config.onlyofficeIdleMinutes,
      documentServerUrl: config.onlyofficeUrl,
      config: editorConfig,
    };
  });

  // 2. ONLYOFFICE Docs 保存回调端点（status=2 关闭保存 / status=6 Ctrl+S 强制保存）
  app.post('/api/v1/onlyoffice/callback', async (req, reply) => {
    const query = req.query as {
      nodeId?: string;
      userId?: string;
      baseVersion?: string;
      expires?: string;
      token?: string;
    };
    const nodeId = query.nodeId ?? '';
    const userId = query.userId ?? '';
    const baseVersion = Number(query.baseVersion ?? '0');
    const expires = Number(query.expires ?? '0');
    const cbToken = query.token ?? '';

    if (!nodeId || !userId || !verifyCallbackToken(nodeId, userId, baseVersion, expires, cbToken)) {
      return reply.code(403).send({ error: 1 });
    }

    let body = (req.body ?? {}) as Record<string, unknown>;

    // 若启用了 ONLYOFFICE JWT，校验回调中的 JWT 签名
    if (config.onlyofficeJwtSecret) {
      const authHeader = String(req.headers.authorization ?? '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const rawJwt = typeof body.token === 'string' ? body.token : bearer;
      if (!rawJwt) {
        return reply.code(403).send({ error: 1 });
      }
      const verified = verifyHs256Jwt(rawJwt, config.onlyofficeJwtSecret);
      if (!verified) {
        return reply.code(403).send({ error: 1 });
      }
      // ONLYOFFICE 某些版本会把 payload 包在 { payload: {...} } 中
      if (verified.payload && typeof verified.payload === 'object') {
        body = { ...body, ...(verified.payload as Record<string, unknown>) };
      } else {
        body = { ...body, ...verified };
      }
    }

    onlyofficeManager.markActivity();
    const status = Number(body.status ?? 0);
    const fileUrl = typeof body.url === 'string' ? body.url : '';

    // status 2 = 文档关闭并准备保存；status 6 = Ctrl+S 强制保存
    if ((status === 2 || status === 6) && fileUrl) {
      try {
        const fetchUrl = resolveCallbackFileUrl(fileUrl);
        const res = await fetch(fetchUrl);
        if (!res.ok) {
          app.log.error(`[ONLYOFFICE] 下载保存文件失败 HTTP ${res.status}: ${fetchUrl}`);
          return reply.code(200).send({ error: 1 });
        }
        // 防御：若保存地址被前端 SPA 兜底成 index.html，绝不能把 HTML 当成文档新版本写入
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('text/html')) {
          app.log.error(`[ONLYOFFICE] 保存地址返回 HTML（疑似被 SPA 兜底），已拒绝: ${fetchUrl}`);
          return reply.code(200).send({ error: 1 });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

        const cur = db
          .prepare(
            `SELECT n.current_version, nf.file_name, nf.mime_type, nf.sha256
             FROM nodes n
             INNER JOIN node_files nf ON nf.id = n.current_file_id
             WHERE n.id = ? AND n.user_id = ?`
          )
          .get(nodeId, userId) as
          | { current_version: number; file_name: string; mime_type: string; sha256: string }
          | undefined;

        if (!cur) return reply.code(200).send({ error: 0 });
        if (cur.sha256 === sha256) {
          // 内容无变化，跳过重复写入新版本
          return reply.code(200).send({ error: 0 });
        }

        const ext = cur.file_name.includes('.') ? cur.file_name.slice(cur.file_name.lastIndexOf('.')) : '';
        const storageKey = `blobs/${sha256.slice(0, 2)}/${sha256}${ext}`;
        await writeStorageFile(storageKey, buf);

        const nextVersion = (cur.current_version ?? 0) + 1;
        const newFileId = crypto.randomUUID();
        const isPdf = cur.file_name.toLowerCase().endsWith('.pdf');

        db.transaction(() => {
          db.prepare(
            `INSERT INTO node_files (id, node_id, version, file_name, mime_type, file_size, sha256, storage_key, preview_pdf_key, preview_status, source_device)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            newFileId,
            nodeId,
            nextVersion,
            cur.file_name,
            cur.mime_type,
            buf.length,
            sha256,
            storageKey,
            isPdf ? storageKey : null,
            isPdf ? 'ready' : 'pending',
            'ONLYOFFICE 在线编辑'
          );

          db.prepare(
            "UPDATE nodes SET current_file_id = ?, current_version = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
          ).run(newFileId, nextVersion, nodeId, userId);
        })();

        enqueuePreviewTask({
          fileId: newFileId,
          nodeId,
          storageKey,
          fileName: cur.file_name,
        });

        app.log.info(`[ONLYOFFICE] 已保存新版本 node=${nodeId} v${nextVersion} (${buf.length} bytes)`);
      } catch (err) {
        app.log.error({ err }, '[ONLYOFFICE] 保存回调处理失败');
        return reply.code(200).send({ error: 1 });
      }
    }

    return reply.code(200).send({ error: 0 });
  });
}

import type {
  FileAccessUrls,
  ImportJobState,
  NodeFileVersion,
  NodeMeta,
  NodeType,
  SearchHit,
  UserProfile,
} from '@yunshu/shared';

const API_BASE_STORAGE_KEY = 'yunshu_api_base';
const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/**
 * 规范化用户填写的服务端地址：
 * - 自动补全 https://
 * - 去掉末尾斜杠
 * - 校验必须是 http/https
 */
export function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('服务器地址格式不正确');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务器地址必须以 http:// 或 https:// 开头');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname === '/' ? '' : pathname}`;
}

/** 当前生效的 API 根地址；空字符串表示与页面同源（Web 部署模式） */
export function getApiBase(): string {
  try {
    const saved = localStorage.getItem(API_BASE_STORAGE_KEY);
    if (saved !== null) return saved;
  } catch {
    /* localStorage 不可用时回退到默认值 */
  }
  return DEFAULT_API_BASE;
}

/** 保存用户填写的服务端地址；传空字符串则清除并回到默认值 */
export function setApiBase(value: string): void {
  const normalized = normalizeApiBase(value);
  try {
    if (normalized) localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    else localStorage.removeItem(API_BASE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 登录前检测服务端是否可达（调用 /api/health） */
export async function testApiBase(value: string): Promise<{ status: string; service?: string }> {
  const base = normalizeApiBase(value);
  if (!base) throw new Error('请先填写服务器地址');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as { status?: string; service?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? `连接失败（HTTP ${res.status}）`);
    return { status: data.status ?? 'ok', service: data.service };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('连接超时，请检查地址和网络');
    }
    throw err instanceof Error ? err : new Error('连接失败');
  } finally {
    window.clearTimeout(timer);
  }
}

function getToken(): string | null {
  return localStorage.getItem('yunshu_token');
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem('yunshu_token', token);
  else localStorage.removeItem('yunshu_token');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error ?? `请求失败（HTTP ${res.status}）`);
    (err as Error & { status?: number; payload?: unknown }).status = res.status;
    (err as Error & { status?: number; payload?: unknown }).payload = data;
    throw err;
  }
  return data as T;
}

export async function sha256File(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const api = {
  register: (email: string, password: string, displayName?: string) =>
    request<{ token: string; user: UserProfile }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: UserProfile }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<UserProfile>('/api/v1/auth/me'),

  getTree: (deleted = false) =>
    request<{ nodes: NodeMeta[]; serverTime: string }>(`/api/v1/nodes/tree?deleted=${deleted}`),

  createNode: (payload: {
    parentId?: string | null;
    title: string;
    nodeType: NodeType;
    contentHtml?: string;
    plainText?: string;
  }) =>
    request<{ node: NodeMeta }>('/api/v1/nodes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getNode: (id: string) =>
    request<{ node: NodeMeta; contentHtml: string; plainText: string }>(`/api/v1/nodes/${id}`),

  updateNode: (
    id: string,
    payload: { title?: string; contentHtml?: string; plainText?: string; isPinned?: boolean }
  ) =>
    request<{ node: NodeMeta }>(`/api/v1/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  moveNode: (
    id: string,
    payload: { newParentId: string | null; prevRank?: string | null; nextRank?: string | null }
  ) =>
    request<{ ok: boolean; rank: string }>(`/api/v1/nodes/${id}/move`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteNode: (id: string) => request<{ ok: boolean }>(`/api/v1/nodes/${id}`, { method: 'DELETE' }),

  search: (q: string, types?: string[]) => {
    const params = new URLSearchParams({ q });
    if (types && types.length > 0) params.set('types', types.join(','));
    return request<{ hits: SearchHit[] }>(`/api/v1/search?${params.toString()}`);
  },

  presignFile: (payload: {
    nodeId: string;
    fileName: string;
    fileSize: number;
    sha256: string;
    mimeType: string;
  }) =>
    request<{ alreadyExists: boolean; storageKey: string; uploadUrl: string | null }>(
      '/api/v1/files/presign',
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  commitFile: (payload: {
    nodeId: string;
    baseVersion: number;
    storageKey: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    deviceName?: string;
    forceConflictCopy?: boolean;
  }) =>
    request<{ ok: boolean; nodeId: string; version: number; createdConflictCopy: boolean }>(
      '/api/v1/files/commit',
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  getFileUrls: (nodeId: string, version?: number) =>
    request<FileAccessUrls>(
      `/api/v1/nodes/${nodeId}/file-urls${version ? `?version=${version}` : ''}`
    ),

  getVersions: (nodeId: string) =>
    request<{ versions: NodeFileVersion[] }>(`/api/v1/nodes/${nodeId}/versions`),

  restoreVersion: (nodeId: string, version: number) =>
    request<{ ok: boolean; version: number }>(`/api/v1/nodes/${nodeId}/versions/${version}/restore`, {
      method: 'POST',
    }),

  importOnePkgBatch: (payload: {
    targetNodeId?: string | null;
    rootTitle: string;
    pages: Array<{ title: string; folderPath: string[]; level: number; htmlContent: string }>;
  }) =>
    request<{ ok: boolean; jobId: string; archiveNodeId: string; importedPages: number }>(
      '/api/v1/migrations/onepkg-batch',
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  startGraphMigration: (accessToken: string, targetNodeId?: string | null) =>
    request<{ ok: boolean; jobId: string }>('/api/v1/migrations/graph', {
      method: 'POST',
      body: JSON.stringify({ accessToken, targetNodeId }),
    }),

  getMigrationJob: (jobId: string) =>
    request<{ job: ImportJobState }>(`/api/v1/migrations/${jobId}`),

  pauseMigrationJob: (jobId: string) =>
    request<{ ok: boolean }>(`/api/v1/migrations/${jobId}/pause`, { method: 'POST' }),
};

/**
 * Tauri 2.0 桌面/移动端运行时桥接（Web 浏览器下自动安全降级）
 */
interface TauriInternals {
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke);
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error('当前运行在浏览器模式，请使用 Windows 桌面客户端以启用本机 Office 唤起与自动回传');
  }
  return internals.invoke<T>(cmd, args);
}

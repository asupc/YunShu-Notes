import type { NodeMeta, NodeType, UserProfile, WorkspaceSection } from '@yunshu/shared';

const USER_CACHE_KEY = 'yunshu_offline_user';
const NODES_CACHE_KEY = 'yunshu_offline_nodes';
const PENDING_OPS_KEY = 'yunshu_offline_pending_ops';
const NOTE_CACHE_PREFIX = 'yunshu_offline_note_';

export interface CachedNoteContent {
  title: string;
  contentHtml: string;
  plainText: string;
  updatedAt: string;
}

export type PendingOp =
  | {
      opId: string;
      type: 'create';
      tempId: string;
      parentId: string | null;
      title: string;
      nodeType: NodeType;
      section: WorkspaceSection;
      contentHtml?: string;
      plainText?: string;
      createdAt: number;
    }
  | {
      opId: string;
      type: 'update';
      nodeId: string;
      payload: {
        title?: string;
        contentHtml?: string;
        plainText?: string;
        isPinned?: boolean;
        saveVersion?: 'auto' | 'manual';
      };
      createdAt: number;
    }
  | {
      opId: string;
      type: 'move';
      nodeId: string;
      newParentId: string | null;
      createdAt: number;
    }
  | {
      opId: string;
      type: 'delete';
      nodeId: string;
      createdAt: number;
    };

function makeOpId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createTempNodeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `local_${crypto.randomUUID()}`;
  }
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isTempNodeId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('local_'));
}

export function saveCachedUser(user: UserProfile): void {
  try {
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function loadCachedUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function saveCachedNodes(nodes: NodeMeta[]): void {
  try {
    localStorage.setItem(NODES_CACHE_KEY, JSON.stringify(nodes));
  } catch {
    /* ignore */
  }
}

export function loadCachedNodes(): NodeMeta[] {
  try {
    const raw = localStorage.getItem(NODES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NodeMeta[]) : [];
  } catch {
    return [];
  }
}

export function saveCachedNoteContent(nodeId: string, content: CachedNoteContent): void {
  try {
    localStorage.setItem(`${NOTE_CACHE_PREFIX}${nodeId}`, JSON.stringify(content));
  } catch {
    /* ignore quota errors */
  }
}

export function loadCachedNoteContent(nodeId: string): CachedNoteContent | null {
  try {
    const raw = localStorage.getItem(`${NOTE_CACHE_PREFIX}${nodeId}`);
    if (!raw) return null;
    return JSON.parse(raw) as CachedNoteContent;
  } catch {
    return null;
  }
}

export function removeCachedNoteContent(nodeId: string): void {
  try {
    localStorage.removeItem(`${NOTE_CACHE_PREFIX}${nodeId}`);
  } catch {
    /* ignore */
  }
}

export function loadPendingOps(): PendingOp[] {
  try {
    const raw = localStorage.getItem(PENDING_OPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingOp[]) : [];
  } catch {
    return [];
  }
}

export function savePendingOps(ops: PendingOp[]): void {
  try {
    if (ops.length === 0) localStorage.removeItem(PENDING_OPS_KEY);
    else localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(ops));
  } catch {
    /* ignore */
  }
}

export function getPendingUpdateForNode(nodeId: string): Extract<PendingOp, { type: 'update' }>['payload'] | null {
  const ops = loadPendingOps();
  let merged: Extract<PendingOp, { type: 'update' }>['payload'] | null = null;
  for (const op of ops) {
    if (op.type === 'create' && op.tempId === nodeId) {
      merged = {
        ...(merged ?? {}),
        title: op.title,
        ...(op.contentHtml !== undefined ? { contentHtml: op.contentHtml } : {}),
        ...(op.plainText !== undefined ? { plainText: op.plainText } : {}),
      };
    } else if (op.type === 'update' && op.nodeId === nodeId) {
      merged = { ...(merged ?? {}), ...op.payload };
    }
  }
  return merged;
}

export function enqueueCreateOp(input: {
  tempId: string;
  parentId: string | null;
  title: string;
  nodeType: NodeType;
  section: WorkspaceSection;
  contentHtml?: string;
  plainText?: string;
}): PendingOp[] {
  const ops = loadPendingOps();
  ops.push({
    opId: makeOpId(),
    type: 'create',
    ...input,
    createdAt: Date.now(),
  });
  savePendingOps(ops);
  return ops;
}

export function enqueueUpdateOp(
  nodeId: string,
  payload: Extract<PendingOp, { type: 'update' }>['payload']
): PendingOp[] {
  const ops = loadPendingOps();

  // 若该节点是离线新建尚未上云的节点，直接把内容/标题合并回 create 操作中
  const createIdx = ops.findIndex((o) => o.type === 'create' && o.tempId === nodeId);
  if (createIdx !== -1) {
    const createOp = ops[createIdx] as Extract<PendingOp, { type: 'create' }>;
    if (payload.title !== undefined) createOp.title = payload.title;
    if (payload.contentHtml !== undefined) createOp.contentHtml = payload.contentHtml;
    if (payload.plainText !== undefined) createOp.plainText = payload.plainText;
    // 如果只是修改 isPinned，则额外保留一条 update
    if (payload.isPinned === undefined) {
      savePendingOps(ops);
      return ops;
    }
  }

  // 合并同一节点的最后一条 update，避免队列膨胀
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op.type === 'update' && op.nodeId === nodeId) {
      op.payload = { ...op.payload, ...payload };
      op.createdAt = Date.now();
      savePendingOps(ops);
      return ops;
    }
  }

  ops.push({
    opId: makeOpId(),
    type: 'update',
    nodeId,
    payload,
    createdAt: Date.now(),
  });
  savePendingOps(ops);
  return ops;
}

export function enqueueMoveOp(nodeId: string, newParentId: string | null): PendingOp[] {
  const ops = loadPendingOps();
  const createIdx = ops.findIndex((o) => o.type === 'create' && o.tempId === nodeId);
  if (createIdx !== -1) {
    (ops[createIdx] as Extract<PendingOp, { type: 'create' }>).parentId = newParentId;
    savePendingOps(ops);
    return ops;
  }
  // 替换同一节点之前未同步的 move
  const filtered = ops.filter((o) => !(o.type === 'move' && o.nodeId === nodeId));
  filtered.push({
    opId: makeOpId(),
    type: 'move',
    nodeId,
    newParentId,
    createdAt: Date.now(),
  });
  savePendingOps(filtered);
  return filtered;
}

export function enqueueDeleteOp(nodeId: string): PendingOp[] {
  const ops = loadPendingOps();
  const wasLocalCreate = ops.some((o) => o.type === 'create' && o.tempId === nodeId);
  // 清理该节点此前所有未同步操作
  const remaining = ops.filter((o) => {
    if (o.type === 'create') return o.tempId !== nodeId;
    return o.nodeId !== nodeId;
  });
  removeCachedNoteContent(nodeId);
  if (!wasLocalCreate) {
    remaining.push({
      opId: makeOpId(),
      type: 'delete',
      nodeId,
      createdAt: Date.now(),
    });
  }
  savePendingOps(remaining);
  return remaining;
}

export function clearAllOfflineCache(): void {
  try {
    localStorage.removeItem(USER_CACHE_KEY);
    localStorage.removeItem(NODES_CACHE_KEY);
    localStorage.removeItem(PENDING_OPS_KEY);
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NOTE_CACHE_PREFIX)) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

import { create } from 'zustand';
import {
  buildNodeTree,
  rankBetween,
  type NodeMeta,
  type NodeTreeItem,
  type NodeType,
  type OfficeSyncState,
  type UserProfile,
  type WorkspaceSection,
} from '@yunshu/shared';
import { api, getToken, isOfflineError, setToken, type ApiError } from '../lib/api';
import {
  clearAllOfflineCache,
  createTempNodeId,
  enqueueCreateOp,
  enqueueDeleteOp,
  enqueueMoveOp,
  enqueueUpdateOp,
  loadCachedNoteContent,
  loadCachedNodes,
  loadCachedUser,
  loadPendingOps,
  removeCachedNoteContent,
  saveCachedNoteContent,
  saveCachedNodes,
  saveCachedUser,
  savePendingOps,
  type PendingOp,
} from '../lib/offlineCache';

const LAST_ACTIVE_NODE_KEY = 'yunshu_last_active_node_id';
const EXPANDED_IDS_KEY = 'yunshu_expanded_ids';
const ACTIVE_TAB_KEY = 'yunshu_active_tab';

function loadSavedTab(): WorkspaceSection {
  return localStorage.getItem(ACTIVE_TAB_KEY) === 'docs' ? 'docs' : 'notes';
}

function loadSavedExpandedIds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_IDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveExpandedIds(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(EXPANDED_IDS_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

function expandAncestors(
  nodes: NodeMeta[],
  targetId: string | null,
  base: Record<string, boolean>
): Record<string, boolean> {
  if (!targetId) return base;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = byId.get(targetId);
  if (!cur) return base;
  const next = { ...base };
  let changed = false;
  while (cur?.parentId) {
    if (!next[cur.parentId]) {
      next[cur.parentId] = true;
      changed = true;
    }
    cur = byId.get(cur.parentId);
  }
  return changed ? next : base;
}

function rebuildTrees(nodes: NodeMeta[]) {
  return {
    tree: buildNodeTree(nodes),
    notesTree: buildNodeTree(nodes.filter((n) => n.section !== 'docs')),
    docsTree: buildNodeTree(nodes.filter((n) => n.section === 'docs')),
  };
}

interface AppState {
  user: UserProfile | null;
  authChecked: boolean;
  nodes: NodeMeta[];
  tree: NodeTreeItem[];
  notesTree: NodeTreeItem[];
  docsTree: NodeTreeItem[];
  activeTab: WorkspaceSection;
  activeNodeId: string | null;
  expandedIds: Record<string, boolean>;
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  mobileDrawerOpen: boolean;
  searchOpen: boolean;
  trashOpen: boolean;
  officeSyncMap: Record<string, OfficeSyncState>;
  syncing: boolean;
  isOffline: boolean;
  pendingCount: number;
  lastSyncedAt: string | null;
  syncError: string | null;
  statusTip: { id: number; text: string; tone: 'info' | 'error' } | null;

  initAuth: () => Promise<void>;
  showTip: (text: string, tone?: 'info' | 'error') => void;
  setUser: (user: UserProfile | null, token?: string | null) => void;
  loadTree: () => Promise<void>;
  manualSync: () => Promise<void>;
  tryReconnect: (silent?: boolean) => Promise<boolean>;
  syncPendingChanges: () => Promise<{ synced: number; remaining: number }>;
  markOffline: (tipText?: string) => void;
  refreshPendingCount: () => void;
  applyLocalCreateNode: (input: {
    parentId: string | null;
    title: string;
    nodeType: NodeType;
    section: WorkspaceSection;
    contentHtml?: string;
    plainText?: string;
  }) => NodeMeta;
  applyLocalUpdateNode: (
    nodeId: string,
    patch: { title?: string; contentHtml?: string; plainText?: string; isPinned?: boolean },
    enqueue?: boolean
  ) => void;
  applyLocalMoveNode: (nodeId: string, newParentId: string | null) => void;
  applyLocalDeleteNode: (nodeId: string) => void;
  setActiveTab: (tab: WorkspaceSection) => void;
  selectNode: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setAllExpanded: (expanded: boolean, section?: WorkspaceSection) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setSidebarOpen: (open: boolean) => void;
  setMobileDrawerOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setOfficeSyncState: (nodeId: string, state: OfficeSyncState) => void;
  markSyncedNow: () => void;
}

let reconnectInFlight = false;

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  authChecked: false,
  nodes: [],
  tree: [],
  notesTree: [],
  docsTree: [],
  activeTab: loadSavedTab(),
  activeNodeId: null,
  expandedIds: loadSavedExpandedIds(),
  theme: (localStorage.getItem('yunshu_theme') as 'light' | 'dark') || 'light',
  sidebarOpen: true,
  mobileDrawerOpen: false,
  searchOpen: false,
  trashOpen: false,
  officeSyncMap: {},
  syncing: false,
  isOffline: false,
  pendingCount: loadPendingOps().length,
  lastSyncedAt: null,
  syncError: null,
  statusTip: null,

  showTip: (text, tone = 'info') => {
    const id = Date.now() + Math.random();
    set({ statusTip: { id, text, tone } });
    window.setTimeout(() => {
      set((s) => (s.statusTip?.id === id ? { statusTip: null } : s));
    }, 3200);
  },

  refreshPendingCount: () => set({ pendingCount: loadPendingOps().length }),

  markOffline: (tipText) => {
    const wasOffline = get().isOffline;
    set({ isOffline: true, pendingCount: loadPendingOps().length });
    if (!wasOffline && tipText) {
      get().showTip(tipText);
    }
  },

  initAuth: async () => {
    const token = getToken();
    if (!token) {
      set({ user: null, authChecked: true, isOffline: false });
      return;
    }

    const hydrateFromCache = () => {
      const cachedUser = loadCachedUser() ?? {
        id: 'offline-user',
        email: '',
        displayName: '离线模式',
        createdAt: new Date().toISOString(),
      };
      const cachedNodes = loadCachedNodes();
      const { tree, notesTree, docsTree } = rebuildTrees(cachedNodes);
      const byId = new Map(cachedNodes.map((n) => [n.id, n]));
      let nextActiveId = get().activeNodeId;
      if (!nextActiveId) {
        const savedId = localStorage.getItem(LAST_ACTIVE_NODE_KEY);
        if (savedId && byId.has(savedId)) nextActiveId = savedId;
      }
      let nextTab = get().activeTab;
      if (nextActiveId) {
        const activeNode = byId.get(nextActiveId);
        if (activeNode) nextTab = activeNode.section === 'docs' ? 'docs' : 'notes';
      }
      const nextExpanded = expandAncestors(cachedNodes, nextActiveId, get().expandedIds);
      set({
        user: cachedUser,
        authChecked: true,
        isOffline: true,
        nodes: cachedNodes,
        tree,
        notesTree,
        docsTree,
        activeTab: nextTab,
        activeNodeId: nextActiveId,
        expandedIds: nextExpanded,
        pendingCount: loadPendingOps().length,
      });
    };

    try {
      const user = await api.me();
      saveCachedUser(user);
      set({ user, authChecked: true, isOffline: false });
      if (loadPendingOps().length > 0) {
        const { synced } = await get().syncPendingChanges();
        if (synced > 0) {
          get().showTip(`已自动同步 ${synced} 项离线修改`);
        }
      }
      await get().loadTree();
    } catch (err) {
      const status = (err as ApiError)?.status;
      if (status === 401) {
        setToken(null);
        clearAllOfflineCache();
        set({ user: null, authChecked: true, isOffline: false });
        return;
      }
      // 服务端不可用、超时或断网：不跳转登录页，直接进入离线模式使用本地缓存
      hydrateFromCache();
      get().showTip('服务端暂不可用，已进入离线模式，将定时尝试重连并同步修改');
    }
  },

  setUser: (user, token) => {
    if (token !== undefined) setToken(token);
    if (!user) {
      localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
      localStorage.removeItem(EXPANDED_IDS_KEY);
      localStorage.removeItem(ACTIVE_TAB_KEY);
      clearAllOfflineCache();
      set({
        user: null,
        authChecked: true,
        isOffline: false,
        pendingCount: 0,
        nodes: [],
        tree: [],
        notesTree: [],
        docsTree: [],
        activeTab: 'notes',
        activeNodeId: null,
        expandedIds: {},
      });
      return;
    }
    saveCachedUser(user);
    set({ user, authChecked: true, isOffline: false });
  },

  loadTree: async () => {
    try {
      const res = await api.getTree(false);
      saveCachedNodes(res.nodes);
      const { tree, notesTree, docsTree } = rebuildTrees(res.nodes);
      const state = get();
      const byId = new Map(res.nodes.map((n) => [n.id, n]));

      let nextActiveId = state.activeNodeId;
      if (nextActiveId && !byId.has(nextActiveId)) {
        nextActiveId = null;
        localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
      }
      if (!nextActiveId) {
        const savedId = localStorage.getItem(LAST_ACTIVE_NODE_KEY);
        if (savedId && byId.has(savedId)) {
          nextActiveId = savedId;
        } else if (savedId) {
          localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
        }
      }

      let nextTab = state.activeTab;
      if (nextActiveId) {
        const activeNode = byId.get(nextActiveId);
        if (activeNode) {
          nextTab = activeNode.section === 'docs' ? 'docs' : 'notes';
          localStorage.setItem(ACTIVE_TAB_KEY, nextTab);
        }
      }

      const nextExpanded = expandAncestors(res.nodes, nextActiveId, state.expandedIds);
      if (nextExpanded !== state.expandedIds) {
        saveExpandedIds(nextExpanded);
      }

      set({
        nodes: res.nodes,
        tree,
        notesTree,
        docsTree,
        activeTab: nextTab,
        activeNodeId: nextActiveId,
        expandedIds: nextExpanded,
        isOffline: false,
        lastSyncedAt: new Date().toISOString(),
        syncError: null,
      });
    } catch (err) {
      if (isOfflineError(err)) {
        const cached = get().nodes.length > 0 ? get().nodes : loadCachedNodes();
        const { tree, notesTree, docsTree } = rebuildTrees(cached);
        set({
          nodes: cached,
          tree,
          notesTree,
          docsTree,
          isOffline: true,
          syncError: null,
        });
        return;
      }
      throw err;
    }
  },

  syncPendingChanges: async () => {
    const ops = loadPendingOps();
    if (ops.length === 0) {
      set({ pendingCount: 0 });
      return { synced: 0, remaining: 0 };
    }

    const idMap = new Map<string, string>();
    const resolveId = (id: string | null): string | null => {
      if (!id) return null;
      return idMap.get(id) ?? id;
    };

    let synced = 0;
    const remaining: PendingOp[] = [];

    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      try {
        if (op.type === 'create') {
          const res = await api.createNode({
            parentId: resolveId(op.parentId),
            title: op.title,
            nodeType: op.nodeType,
            section: op.section,
            contentHtml: op.contentHtml,
            plainText: op.plainText,
          });
          idMap.set(op.tempId, res.node.id);
          const cachedContent = loadCachedNoteContent(op.tempId);
          if (cachedContent) {
            saveCachedNoteContent(res.node.id, cachedContent);
            removeCachedNoteContent(op.tempId);
          }
          if (get().activeNodeId === op.tempId) {
            localStorage.setItem(LAST_ACTIVE_NODE_KEY, res.node.id);
            set({ activeNodeId: res.node.id });
          }
          synced += 1;
        } else if (op.type === 'update') {
          const targetId = resolveId(op.nodeId)!;
          await api.updateNode(targetId, {
            ...op.payload,
            saveVersion: op.payload.saveVersion ?? 'auto',
          });
          synced += 1;
        } else if (op.type === 'move') {
          const targetId = resolveId(op.nodeId)!;
          await api.moveNode(targetId, { newParentId: resolveId(op.newParentId) });
          synced += 1;
        } else if (op.type === 'delete') {
          const targetId = resolveId(op.nodeId)!;
          await api.deleteNode(targetId);
          synced += 1;
        }
      } catch (err) {
        if (isOfflineError(err)) {
          // 中途再次断网：把当前及后续未执行操作写回队列（已映射的 ID 同步更新）
          for (let j = i; j < ops.length; j += 1) {
            const pending = { ...ops[j] } as PendingOp;
            if (pending.type === 'create') {
              pending.parentId = resolveId(pending.parentId);
            } else if (pending.type === 'move') {
              pending.nodeId = resolveId(pending.nodeId)!;
              pending.newParentId = resolveId(pending.newParentId);
            } else {
              pending.nodeId = resolveId(pending.nodeId)!;
            }
            remaining.push(pending);
          }
          break;
        }
        // 非网络错误（如节点已被其他端删除 404）：跳过此条以免阻塞队列
        const status = (err as ApiError)?.status;
        if (status === 401) {
          remaining.push(...ops.slice(i));
          break;
        }
      }
    }

    savePendingOps(remaining);
    set({ pendingCount: remaining.length });
    return { synced, remaining: remaining.length };
  },

  tryReconnect: async (silent = true) => {
    if (reconnectInFlight || !getToken()) return false;
    reconnectInFlight = true;
    try {
      const user = await api.me();
      saveCachedUser(user);
      const wasOffline = get().isOffline;
      const { synced, remaining } = await get().syncPendingChanges();
      if (remaining > 0) {
        set({ isOffline: true, pendingCount: remaining });
        return false;
      }
      set({ user, isOffline: false, pendingCount: 0, syncError: null });
      await get().loadTree();
      if (synced > 0) {
        get().showTip(`已恢复连接，自动同步了 ${synced} 项离线修改`);
      } else if (wasOffline && !silent) {
        get().showTip('已重新连接服务端');
      } else if (wasOffline) {
        get().showTip('已重新连接服务端');
      }
      return true;
    } catch (err) {
      const status = (err as ApiError)?.status;
      if (status === 401) {
        setToken(null);
        clearAllOfflineCache();
        set({ user: null, isOffline: false, pendingCount: 0 });
        get().showTip('登录状态已失效，请重新登录', 'error');
        return false;
      }
      set({ isOffline: true });
      return false;
    } finally {
      reconnectInFlight = false;
    }
  },

  manualSync: async () => {
    if (get().syncing) return;
    set({ syncing: true, syncError: null });
    try {
      // 通知当前编辑器立即保存当前改动
      window.dispatchEvent(new CustomEvent('yunshu:manual-sync'));
      const ok = await get().tryReconnect(false);
      if (!ok) {
        set({ isOffline: true, syncError: null });
        get().showTip('服务端暂不可达，修改已保存在本地，将在恢复后自动同步');
      }
    } catch (err) {
      if (isOfflineError(err)) {
        set({ isOffline: true, syncError: null });
        get().showTip('服务端暂不可达，修改已保存在本地');
      } else {
        set({ syncError: err instanceof Error ? err.message : '同步失败' });
      }
    } finally {
      set({ syncing: false });
    }
  },

  applyLocalCreateNode: ({ parentId, title, nodeType, section, contentHtml = '', plainText = '' }) => {
    const tempId = createTempNodeId();
    const curNodes = get().nodes;
    const parent = parentId ? curNodes.find((n) => n.id === parentId) : null;
    const parentPath = parent ? parent.path : '/root/';
    const siblings = curNodes.filter((n) => n.parentId === parentId && n.section === section);
    const lastRank = siblings.length > 0 ? siblings[siblings.length - 1].rank : null;
    const now = new Date().toISOString();

    const newNode: NodeMeta = {
      id: tempId,
      parentId,
      path: `${parentPath}${tempId}/`,
      rank: rankBetween(lastRank, null),
      title,
      nodeType,
      section,
      currentVersion: 1,
      isPinned: false,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    };

    const nextNodes = [...curNodes, newNode];
    saveCachedNodes(nextNodes);
    if (nodeType === 'note' || nodeType === 'markdown') {
      saveCachedNoteContent(tempId, { title, contentHtml, plainText, updatedAt: now });
    }
    const ops = enqueueCreateOp({
      tempId,
      parentId,
      title,
      nodeType,
      section,
      contentHtml,
      plainText,
    });
    const { tree, notesTree, docsTree } = rebuildTrees(nextNodes);
    set({
      nodes: nextNodes,
      tree,
      notesTree,
      docsTree,
      isOffline: true,
      pendingCount: ops.length,
    });
    return newNode;
  },

  applyLocalUpdateNode: (nodeId, patch, enqueue = true) => {
    const now = new Date().toISOString();
    const nextNodes = get().nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.isPinned !== undefined ? { isPinned: patch.isPinned } : {}),
            updatedAt: now,
          }
        : n
    );
    saveCachedNodes(nextNodes);
    const { tree, notesTree, docsTree } = rebuildTrees(nextNodes);
    let pendingCount = get().pendingCount;
    if (enqueue) {
      const ops = enqueueUpdateOp(nodeId, patch);
      pendingCount = ops.length;
    }
    set({
      nodes: nextNodes,
      tree,
      notesTree,
      docsTree,
      pendingCount,
    });
  },

  applyLocalMoveNode: (nodeId, newParentId) => {
    const curNodes = get().nodes;
    const target = curNodes.find((n) => n.id === nodeId);
    if (!target) return;
    const newParent = newParentId ? curNodes.find((n) => n.id === newParentId) : null;
    const newParentPath = newParent ? newParent.path : '/root/';
    const oldPath = target.path;
    const newPrefix = `${newParentPath}${nodeId}/`;
    const now = new Date().toISOString();

    const nextNodes = curNodes.map((n) => {
      if (n.id === nodeId) {
        return { ...n, parentId: newParentId, path: newPrefix, updatedAt: now };
      }
      if (n.path.startsWith(oldPath)) {
        return { ...n, path: newPrefix + n.path.slice(oldPath.length), updatedAt: now };
      }
      return n;
    });

    saveCachedNodes(nextNodes);
    const ops = enqueueMoveOp(nodeId, newParentId);
    const { tree, notesTree, docsTree } = rebuildTrees(nextNodes);
    set({
      nodes: nextNodes,
      tree,
      notesTree,
      docsTree,
      isOffline: true,
      pendingCount: ops.length,
    });
  },

  applyLocalDeleteNode: (nodeId) => {
    const curNodes = get().nodes;
    const target = curNodes.find((n) => n.id === nodeId);
    if (!target) return;
    const nextNodes = curNodes.filter((n) => n.id !== nodeId && !n.path.startsWith(target.path));
    saveCachedNodes(nextNodes);
    const ops = enqueueDeleteOp(nodeId);
    const { tree, notesTree, docsTree } = rebuildTrees(nextNodes);
    const nextActiveId =
      get().activeNodeId && nextNodes.some((n) => n.id === get().activeNodeId)
        ? get().activeNodeId
        : null;
    if (!nextActiveId) localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
    set({
      nodes: nextNodes,
      tree,
      notesTree,
      docsTree,
      activeNodeId: nextActiveId,
      isOffline: true,
      pendingCount: ops.length,
    });
  },

  setActiveTab: (tab) => {
    localStorage.setItem(ACTIVE_TAB_KEY, tab);
    set({ activeTab: tab });
  },

  selectNode: (id) => {
    if (id) {
      localStorage.setItem(LAST_ACTIVE_NODE_KEY, id);
    } else {
      localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
    }
    set((s) => {
      const target = id ? s.nodes.find((n) => n.id === id) : null;
      const nextTab: WorkspaceSection = target
        ? target.section === 'docs'
          ? 'docs'
          : 'notes'
        : s.activeTab;
      if (nextTab !== s.activeTab) {
        localStorage.setItem(ACTIVE_TAB_KEY, nextTab);
      }
      const nextExpanded = expandAncestors(s.nodes, id, s.expandedIds);
      if (nextExpanded !== s.expandedIds) {
        saveExpandedIds(nextExpanded);
      }
      return {
        activeNodeId: id,
        activeTab: nextTab,
        expandedIds: nextExpanded,
        mobileDrawerOpen: false,
      };
    });
  },

  toggleExpand: (id) =>
    set((s) => {
      const next = { ...s.expandedIds, [id]: !s.expandedIds[id] };
      saveExpandedIds(next);
      return { expandedIds: next };
    }),

  setAllExpanded: (expanded, section) =>
    set((s) => {
      const next = { ...s.expandedIds };
      for (const n of s.nodes) {
        if (!section || n.section === section) {
          if (expanded) next[n.id] = true;
          else delete next[n.id];
        }
      }
      saveExpandedIds(next);
      return { expandedIds: next };
    }),

  setTheme: (theme) => {
    localStorage.setItem('yunshu_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMobileDrawerOpen: (mobileDrawerOpen) => set({ mobileDrawerOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setTrashOpen: (trashOpen) => set({ trashOpen }),
  setOfficeSyncState: (nodeId, state) =>
    set((s) => ({ officeSyncMap: { ...s.officeSyncMap, [nodeId]: state } })),
  markSyncedNow: () => set({ lastSyncedAt: new Date().toISOString(), syncError: null }),
}));

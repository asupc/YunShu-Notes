import { create } from 'zustand';
import { buildNodeTree, type NodeMeta, type NodeTreeItem, type OfficeSyncState, type UserProfile } from '@yunshu/shared';
import { api, setToken } from '../lib/api';

const LAST_ACTIVE_NODE_KEY = 'yunshu_last_active_node_id';
const EXPANDED_IDS_KEY = 'yunshu_expanded_ids';

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

interface AppState {
  user: UserProfile | null;
  authChecked: boolean;
  nodes: NodeMeta[];
  tree: NodeTreeItem[];
  activeNodeId: string | null;
  expandedIds: Record<string, boolean>;
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  mobileDrawerOpen: boolean;
  searchOpen: boolean;
  officeSyncMap: Record<string, OfficeSyncState>;
  syncing: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;

  initAuth: () => Promise<void>;
  setUser: (user: UserProfile | null, token?: string | null) => void;
  loadTree: () => Promise<void>;
  manualSync: () => Promise<void>;
  selectNode: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setAllExpanded: (expanded: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setSidebarOpen: (open: boolean) => void;
  setMobileDrawerOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setOfficeSyncState: (nodeId: string, state: OfficeSyncState) => void;
  markSyncedNow: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  authChecked: false,
  nodes: [],
  tree: [],
  activeNodeId: null,
  expandedIds: loadSavedExpandedIds(),
  theme: (localStorage.getItem('yunshu_theme') as 'light' | 'dark') || 'light',
  sidebarOpen: true,
  mobileDrawerOpen: false,
  searchOpen: false,
  officeSyncMap: {},
  syncing: false,
  lastSyncedAt: null,
  syncError: null,

  initAuth: async () => {
    try {
      const user = await api.me();
      set({ user, authChecked: true });
      await get().loadTree();
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  setUser: (user, token) => {
    if (token !== undefined) setToken(token);
    if (!user) {
      localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
      localStorage.removeItem(EXPANDED_IDS_KEY);
      set({
        user: null,
        authChecked: true,
        nodes: [],
        tree: [],
        activeNodeId: null,
        expandedIds: {},
      });
      return;
    }
    set({ user, authChecked: true });
  },

  loadTree: async () => {
    const res = await api.getTree(false);
    const tree = buildNodeTree(res.nodes);
    const state = get();
    const idSet = new Set(res.nodes.map((n) => n.id));

    let nextActiveId = state.activeNodeId;
    if (nextActiveId && !idSet.has(nextActiveId)) {
      nextActiveId = null;
      localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
    }
    if (!nextActiveId) {
      const savedId = localStorage.getItem(LAST_ACTIVE_NODE_KEY);
      if (savedId && idSet.has(savedId)) {
        nextActiveId = savedId;
      } else if (savedId) {
        localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
      }
    }

    const nextExpanded = expandAncestors(res.nodes, nextActiveId, state.expandedIds);
    if (nextExpanded !== state.expandedIds) {
      saveExpandedIds(nextExpanded);
    }

    set({
      nodes: res.nodes,
      tree,
      activeNodeId: nextActiveId,
      expandedIds: nextExpanded,
      lastSyncedAt: new Date().toISOString(),
      syncError: null,
    });
  },

  manualSync: async () => {
    if (get().syncing) return;
    set({ syncing: true, syncError: null });
    try {
      // 通知当前编辑器立即刷盘并同步最新目录树
      window.dispatchEvent(new CustomEvent('yunshu:manual-sync'));
      await get().loadTree();
    } catch (err) {
      set({ syncError: err instanceof Error ? err.message : '同步失败' });
    } finally {
      set({ syncing: false });
    }
  },

  selectNode: (id) => {
    if (id) {
      localStorage.setItem(LAST_ACTIVE_NODE_KEY, id);
    } else {
      localStorage.removeItem(LAST_ACTIVE_NODE_KEY);
    }
    set((s) => {
      const nextExpanded = expandAncestors(s.nodes, id, s.expandedIds);
      if (nextExpanded !== s.expandedIds) {
        saveExpandedIds(nextExpanded);
      }
      return { activeNodeId: id, expandedIds: nextExpanded, mobileDrawerOpen: false };
    });
  },

  toggleExpand: (id) =>
    set((s) => {
      const next = { ...s.expandedIds, [id]: !s.expandedIds[id] };
      saveExpandedIds(next);
      return { expandedIds: next };
    }),

  setAllExpanded: (expanded) =>
    set((s) => {
      if (!expanded) {
        saveExpandedIds({});
        return { expandedIds: {} };
      }
      const next: Record<string, boolean> = {};
      for (const n of s.nodes) next[n.id] = true;
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
  setOfficeSyncState: (nodeId, state) =>
    set((s) => ({ officeSyncMap: { ...s.officeSyncMap, [nodeId]: state } })),
  markSyncedNow: () => set({ lastSyncedAt: new Date().toISOString(), syncError: null }),
}));

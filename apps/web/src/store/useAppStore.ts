import { create } from 'zustand';
import {
  buildNodeTree,
  type NodeMeta,
  type NodeTreeItem,
  type OfficeSyncState,
  type UserProfile,
  type WorkspaceSection,
} from '@yunshu/shared';
import { api, setToken } from '../lib/api';

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
  officeSyncMap: Record<string, OfficeSyncState>;
  syncing: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;

  initAuth: () => Promise<void>;
  setUser: (user: UserProfile | null, token?: string | null) => void;
  loadTree: () => Promise<void>;
  manualSync: () => Promise<void>;
  setActiveTab: (tab: WorkspaceSection) => void;
  selectNode: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setAllExpanded: (expanded: boolean, section?: WorkspaceSection) => void;
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
  notesTree: [],
  docsTree: [],
  activeTab: loadSavedTab(),
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
      localStorage.removeItem(ACTIVE_TAB_KEY);
      set({
        user: null,
        authChecked: true,
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
    set({ user, authChecked: true });
  },

  loadTree: async () => {
    const res = await api.getTree(false);
    const tree = buildNodeTree(res.nodes);
    const notesTree = buildNodeTree(res.nodes.filter((n) => n.section !== 'docs'));
    const docsTree = buildNodeTree(res.nodes.filter((n) => n.section === 'docs'));
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
      lastSyncedAt: new Date().toISOString(),
      syncError: null,
    });
  },

  manualSync: async () => {
    if (get().syncing) return;
    set({ syncing: true, syncError: null });
    try {
      window.dispatchEvent(new CustomEvent('yunshu:manual-sync'));
      await get().loadTree();
    } catch (err) {
      set({ syncError: err instanceof Error ? err.message : '同步失败' });
    } finally {
      set({ syncing: false });
    }
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
  setOfficeSyncState: (nodeId, state) =>
    set((s) => ({ officeSyncMap: { ...s.officeSyncMap, [nodeId]: state } })),
  markSyncedNow: () => set({ lastSyncedAt: new Date().toISOString(), syncError: null }),
}));

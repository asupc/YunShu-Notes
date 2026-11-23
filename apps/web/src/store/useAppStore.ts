import { create } from 'zustand';
import { buildNodeTree, type NodeMeta, type NodeTreeItem, type OfficeSyncState, type UserProfile } from '@yunshu/shared';
import { api, setToken } from '../lib/api';

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
  migrationOpen: boolean;
  officeSyncMap: Record<string, OfficeSyncState>;

  initAuth: () => Promise<void>;
  setUser: (user: UserProfile | null, token?: string | null) => void;
  loadTree: () => Promise<void>;
  selectNode: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setSidebarOpen: (open: boolean) => void;
  setMobileDrawerOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setMigrationOpen: (open: boolean) => void;
  setOfficeSyncState: (nodeId: string, state: OfficeSyncState) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  authChecked: false,
  nodes: [],
  tree: [],
  activeNodeId: null,
  expandedIds: {},
  theme: (localStorage.getItem('yunshu_theme') as 'light' | 'dark') || 'light',
  sidebarOpen: true,
  mobileDrawerOpen: false,
  searchOpen: false,
  migrationOpen: false,
  officeSyncMap: {},

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
    set({ user, authChecked: true });
  },

  loadTree: async () => {
    const res = await api.getTree(false);
    const tree = buildNodeTree(res.nodes);
    set({ nodes: res.nodes, tree });
  },

  selectNode: (id) => set({ activeNodeId: id, mobileDrawerOpen: false }),

  toggleExpand: (id) =>
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: !s.expandedIds[id] } })),

  setTheme: (theme) => {
    localStorage.setItem('yunshu_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMobileDrawerOpen: (mobileDrawerOpen) => set({ mobileDrawerOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setMigrationOpen: (migrationOpen) => set({ migrationOpen }),
  setOfficeSyncState: (nodeId, state) =>
    set((s) => ({ officeSyncMap: { ...s.officeSyncMap, [nodeId]: state } })),
}));

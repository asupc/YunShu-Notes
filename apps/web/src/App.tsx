import React, { useEffect, useRef, useState } from 'react';
import { Menu, PanelLeft, RefreshCw } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { NoteEditor } from './components/NoteEditor';
import { FolderGridView } from './components/FolderGridView';
import { OfficePreview } from './components/OfficePreview';
import { SearchModal } from './components/SearchModal';
import { SidebarTree } from './components/SidebarTree';
import { useLayoutMode } from './hooks/useLayoutMode';
import { isTauriRuntime } from './lib/api';
import { useAppStore } from './store/useAppStore';

function formatSyncTime(iso: string | null): string {
  if (!iso) return '尚未同步';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '尚未同步';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export const App: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const authChecked = useAppStore((s) => s.authChecked);
  const nodes = useAppStore((s) => s.nodes);
  const activeNodeId = useAppStore((s) => s.activeNodeId);
  const theme = useAppStore((s) => s.theme);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);
  const syncing = useAppStore((s) => s.syncing);
  const lastSyncedAt = useAppStore((s) => s.lastSyncedAt);
  const syncError = useAppStore((s) => s.syncError);

  const initAuth = useAppStore((s) => s.initAuth);
  const manualSync = useAppStore((s) => s.manualSync);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);

  const { layoutMode, isSplitLayout, isTouchDevice } = useLayoutMode();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('yunshu_sidebar_width') || '268');
    return Number.isFinite(saved) && saved >= 200 && saved <= 440 ? saved : 268;
  });

  const resizingRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    void initAuth();
  }, [initAuth, theme]);

  useEffect(() => {
    if (isSplitLayout && mobileDrawerOpen) {
      setMobileDrawerOpen(false);
    }
  }, [isSplitLayout, mobileDrawerOpen, setMobileDrawerOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        if (isSplitLayout) {
          setSidebarOpen(!useAppStore.getState().sidebarOpen);
        } else {
          setMobileDrawerOpen(!useAppStore.getState().mobileDrawerOpen);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSearchOpen, setSidebarOpen, setMobileDrawerOpen, isSplitLayout]);

  const handleResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(440, Math.max(200, ev.clientX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      localStorage.setItem('yunshu_sidebar_width', String(sidebarWidth));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isSplitLayout || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX <= 28 || mobileDrawerOpen) {
      touchStartRef.current = { x: t.clientX, y: t.clientY };
    } else {
      touchStartRef.current = null;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isSplitLayout || !touchStartRef.current || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = Math.abs(t.clientY - touchStartRef.current.y);
    if (dy < 60) {
      if (!mobileDrawerOpen && dx > 56) setMobileDrawerOpen(true);
      else if (mobileDrawerOpen && dx < -56) setMobileDrawerOpen(false);
    }
    touchStartRef.current = null;
  };

  if (!authChecked) {
    return (
      <div className="h-[100dvh] flex items-center justify-center text-sm text-slate-500">
        正在加载云树笔记...
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;
  const isOfficeFile =
    activeNode && (activeNode.nodeType === 'docx' || activeNode.nodeType === 'xlsx' || activeNode.nodeType === 'pdf');

  const drawerWidthClass = layoutMode === 'tablet-portrait' ? 'w-[320px]' : 'w-[82vw] max-w-[300px]';

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="h-[100dvh] flex flex-col overflow-hidden bg-white dark:bg-black safe-area-shell"
    >
      {/* 顶部全局导航栏（含手动同步按钮与上次同步时间） */}
      <header className="h-11 shrink-0 px-3 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-2 bg-slate-50/80 dark:bg-black">
        <div className="flex items-center gap-2 min-w-0">
          {isSplitLayout ? (
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="inline-flex items-center justify-center p-1.5 rounded hover:bg-slate-200 dark:hover:bg-neutral-900"
              title="展开/收起左侧目录树 (Ctrl+\)"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(!mobileDrawerOpen)}
              className="inline-flex items-center justify-center p-2 -ml-1 rounded hover:bg-slate-200 dark:hover:bg-neutral-900"
              title="打开目录树"
            >
              <Menu className="w-4 h-4" />
            </button>
          )}
          {!isTauriRuntime() && (
            <>
              <img src="/logo-192.png" alt="云树笔记" className="w-5 h-5 rounded shrink-0" />
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100 shrink-0">云树笔记</span>
              {activeNode && <span className="text-slate-300 shrink-0">/</span>}
            </>
          )}
          {activeNode ? (
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{activeNode.title}</span>
          ) : (
            isTauriRuntime() && <span className="text-xs text-slate-400">全部笔记</span>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0 text-xs">
          <span
            className={`hidden sm:inline whitespace-nowrap ${
              syncError ? 'text-red-600' : 'text-slate-500 dark:text-slate-400'
            }`}
            title={lastSyncedAt ? `上次同步时间：${new Date(lastSyncedAt).toLocaleString('zh-CN')}` : '尚未同步'}
          >
            {syncing ? '同步中...' : syncError ? '同步失败' : `上次同步：${formatSyncTime(lastSyncedAt)}`}
          </span>

          <button
            type="button"
            disabled={syncing}
            onClick={() => void manualSync()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-slate-100 dark:hover:bg-neutral-800 text-slate-700 dark:text-slate-200 disabled:opacity-60"
            title="立即手动同步当前笔记与目录树"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin text-blue-600' : ''}`} />
            <span className="hidden sm:inline">手动同步</span>
          </button>

          <span className="text-slate-500 hidden md:inline">{user.displayName}</span>
        </div>
      </header>

      {/* 主体：PC/平板横屏常驻可调宽分栏 + 平板竖屏/手机侧滑抽屉 + 全宽编辑区 */}
      <div className="flex-1 flex overflow-hidden relative">
        {isSplitLayout && sidebarOpen && (
          <div className="h-full flex shrink-0" style={{ width: `${sidebarWidth}px` }}>
            <SidebarTree touchFriendly={isTouchDevice} />
            <div
              onPointerDown={handleResizeStart}
              title="拖拽调整目录宽度"
              className="w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500 transition-colors shrink-0"
            />
          </div>
        )}

        {!isSplitLayout && mobileDrawerOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-900/40 flex"
            onClick={() => setMobileDrawerOpen(false)}
          >
            <div
              className={`h-full ${drawerWidthClass} shadow-xl`}
              onClick={(e) => e.stopPropagation()}
            >
              <SidebarTree touchFriendly />
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0 flex overflow-hidden">
          {!activeNode ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-400">
              <div className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-2">
                欢迎回到云树笔记
              </div>
              <p className="text-xs max-w-md leading-relaxed">
                {isSplitLayout
                  ? '在左侧无限层级目录树中选择任意笔记、Markdown 或 Word/Excel 文档，或按 Ctrl+K 全局搜索。'
                  : '点击左上角菜单按钮或从屏幕左边缘向右滑动打开目录树。'}
              </p>
            </div>
          ) : activeNode.nodeType === 'folder' ? (
            <FolderGridView folder={activeNode} />
          ) : isOfficeFile ? (
            <OfficePreview node={activeNode} />
          ) : (
            <NoteEditor node={activeNode} />
          )}
        </main>
      </div>

      <SearchModal />
    </div>
  );
};

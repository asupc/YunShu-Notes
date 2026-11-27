import React, { useEffect, useRef, useState } from 'react';
import { Menu, PanelLeft, RefreshCw } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { NoteEditor } from './components/NoteEditor';
import { FolderGridView } from './components/FolderGridView';
import { OfficePreview } from './components/OfficePreview';
import { SearchModal } from './components/SearchModal';
import { TrashDrawer } from './components/TrashDrawer';
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

// 文档预览/编辑器出错时只降级主内容区，避免整个应用白屏。
type EditorErrorBoundaryProps = { children: React.ReactNode; resetKey?: string };

class EditorErrorBoundary extends React.Component<
  EditorErrorBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: EditorErrorBoundaryProps) {
    // 切换到另一篇文档时自动恢复，不必整页刷新
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: unknown) {
    console.error('[Editor] 渲染失败', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md text-center p-8 bg-white dark:bg-black rounded-xl border border-slate-200 dark:border-neutral-800 shadow-sm">
            <p className="text-base font-semibold text-slate-800 dark:text-slate-100 mb-2">
              内容加载异常
            </p>
            <p className="text-xs text-slate-500 mb-5">
              请重新加载；若问题持续，可切换到其他文档后再返回。
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
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
  const isOffline = useAppStore((s) => s.isOffline);
  const pendingCount = useAppStore((s) => s.pendingCount);
  const lastSyncedAt = useAppStore((s) => s.lastSyncedAt);
  const syncError = useAppStore((s) => s.syncError);
  const statusTip = useAppStore((s) => s.statusTip);

  const initAuth = useAppStore((s) => s.initAuth);
  const manualSync = useAppStore((s) => s.manualSync);
  const tryReconnect = useAppStore((s) => s.tryReconnect);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);

  const { layoutMode, isSplitLayout, isTouchDevice } = useLayoutMode();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('yunshu_sidebar_width') || '268');
    return Number.isFinite(saved) && saved >= 180 && saved <= 640 ? saved : 268;
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [headerMetaSlot, setHeaderMetaSlot] = useState<HTMLDivElement | null>(null);
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLDivElement | null>(null);

  const resizingRef = useRef(false);
  const latestSidebarWidthRef = useRef(sidebarWidth);
  latestSidebarWidthRef.current = sidebarWidth;
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  // 离线或存在未同步本地修改时：每 15 秒定时尝试连接服务端并自动同步，同时监听网络恢复事件
  useEffect(() => {
    if (!user) return;
    if (!isOffline && pendingCount === 0) return;

    const onOnline = () => {
      void tryReconnect(false);
    };
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      void tryReconnect(true);
    }, 15000);

    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [user, isOffline, pendingCount, tryReconnect]);

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
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    setIsResizingSidebar(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const startX = e.clientX;
    const startW = latestSidebarWidthRef.current;

    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      if (ev.cancelable) ev.preventDefault();
      const maxAllowed = Math.min(640, Math.max(360, Math.floor(window.innerWidth * 0.55)));
      const next = Math.min(maxAllowed, Math.max(180, Math.round(startW + (ev.clientX - startX))));
      latestSidebarWidthRef.current = next;
      setSidebarWidth(next);
    };

    const finishResize = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      setIsResizingSidebar(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('yunshu_sidebar_width', String(latestSidebarWidthRef.current));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  };

  const handleResetSidebarWidth = () => {
    latestSidebarWidthRef.current = 268;
    setSidebarWidth(268);
    localStorage.setItem('yunshu_sidebar_width', '268');
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
          <div ref={setHeaderMetaSlot} className="flex items-center gap-1.5 shrink-0" />
        </div>

        <div className="flex items-center gap-2 shrink-0 text-xs">
          <div ref={setHeaderActionsSlot} className="flex items-center gap-1.5 shrink-0" />
          {isOffline ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 whitespace-nowrap"
              title="服务端暂不可达，每 15 秒自动重连并在恢复后同步本地修改"
            >
              ● 离线模式{pendingCount > 0 ? `（${pendingCount} 项待同步）` : ''}
            </span>
          ) : (
            <span
              className={`hidden sm:inline whitespace-nowrap ${
                syncError ? 'text-red-600' : 'text-slate-500 dark:text-slate-400'
              }`}
              title={lastSyncedAt ? `上次同步时间：${new Date(lastSyncedAt).toLocaleString('zh-CN')}` : '尚未同步'}
            >
              {syncing
                ? '同步中...'
                : pendingCount > 0
                ? `待同步：${pendingCount} 项`
                : syncError
                ? '同步失败'
                : `上次同步：${formatSyncTime(lastSyncedAt)}`}
            </span>
          )}

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
          <div className="relative h-full flex shrink-0" style={{ width: `${sidebarWidth}px` }}>
            <SidebarTree touchFriendly={isTouchDevice} />
            {/* 宽热区（10px）分割拖拽条，视觉纤细、支持鼠标与触控拖动，双击恢复默认宽度 */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="拖拽调整目录树宽度"
              onPointerDown={handleResizeStart}
              onDoubleClick={handleResetSidebarWidth}
              style={{ touchAction: 'none' }}
              title="左右拖动调整导航宽度（双击恢复默认）"
              className="group absolute top-0 -right-[5px] bottom-0 w-[10px] z-30 cursor-col-resize flex items-center justify-center"
            >
              <div
                className={`h-full transition-all ${
                  isResizingSidebar
                    ? 'w-[3px] bg-blue-500'
                    : 'w-[2px] bg-transparent group-hover:bg-blue-500/70'
                }`}
              />
            </div>
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

        <main className={`flex-1 min-w-0 flex overflow-hidden ${isResizingSidebar ? 'pointer-events-none select-none' : ''}`}>
          <EditorErrorBoundary resetKey={activeNode?.id ?? ''}>
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
              <OfficePreview node={activeNode} headerMetaSlot={headerMetaSlot} headerActionsSlot={headerActionsSlot} />
            ) : (
              <NoteEditor node={activeNode} />
            )}
          </EditorErrorBoundary>
        </main>
      </div>

      <SearchModal />
      <TrashDrawer />

      {/* 全局底部统一 Tips 提示条 */}
      {statusTip && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] px-4 py-2 rounded-lg text-xs font-medium shadow-xl border backdrop-blur-sm pointer-events-none ${
            statusTip.tone === 'error'
              ? 'bg-red-50/95 dark:bg-red-950/95 text-red-700 dark:text-red-200 border-red-200 dark:border-red-800'
              : 'bg-slate-900/92 dark:bg-neutral-900/95 text-white dark:text-slate-100 border-slate-700/80 dark:border-neutral-700'
          }`}
        >
          {statusTip.text}
        </div>
      )}
    </div>
  );
};

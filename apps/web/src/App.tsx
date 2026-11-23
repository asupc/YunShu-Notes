import React, { useEffect } from 'react';
import { Menu, PanelLeft } from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { MigrationModal } from './components/MigrationModal';
import { NoteEditor } from './components/NoteEditor';
import { OfficePreview } from './components/OfficePreview';
import { SearchModal } from './components/SearchModal';
import { SidebarTree } from './components/SidebarTree';
import { useAppStore } from './store/useAppStore';

export const App: React.FC = () => {
  const user = useAppStore((s) => s.user);
  const authChecked = useAppStore((s) => s.authChecked);
  const nodes = useAppStore((s) => s.nodes);
  const activeNodeId = useAppStore((s) => s.activeNodeId);
  const theme = useAppStore((s) => s.theme);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);

  const initAuth = useAppStore((s) => s.initAuth);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    void initAuth();
  }, [initAuth, theme]);

  // 全局快捷键：Ctrl+K 全局搜索，Ctrl+\ 展开收起侧栏
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen(!useAppStore.getState().sidebarOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSearchOpen, setSidebarOpen]);

  if (!authChecked) {
    return (
      <div className="h-screen flex items-center justify-center text-sm text-slate-500">
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

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* 顶部全局状态栏 */}
      <header className="h-11 shrink-0 px-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-900">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(true)}
            className="md:hidden p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
            title="打开目录树"
          >
            <Menu className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:inline-flex p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
            title="展开/收起左侧目录树 (Ctrl+\)"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-bold text-blue-700 dark:text-blue-400">云树笔记</span>
          {activeNode && (
            <>
              <span className="text-slate-300">/</span>
              <span className="text-xs text-slate-600 dark:text-slate-300 truncate">{activeNode.title}</span>
            </>
          )}
        </div>
        <div className="text-xs text-slate-500">{user.displayName}</div>
      </header>

      {/* 主体：桌面端侧栏 + 移动端抽屉 + 内容工作区 */}
      <div className="flex-1 flex overflow-hidden relative">
        {sidebarOpen && (
          <div className="hidden md:block h-full">
            <SidebarTree />
          </div>
        )}

        {mobileDrawerOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-slate-900/40 flex"
            onClick={() => setMobileDrawerOpen(false)}
          >
            <div className="h-full" onClick={(e) => e.stopPropagation()}>
              <SidebarTree />
            </div>
          </div>
        )}

        <main className="flex-1 flex overflow-hidden">
          {!activeNode ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-400">
              <div className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-2">
                欢迎回到云树笔记
              </div>
              <p className="text-xs max-w-md leading-relaxed">
                在左侧无限层级目录树中选择任意笔记、Markdown 或 Word/Excel 文档，或按 <kbd className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">Ctrl+K</kbd> 全局搜索。
              </p>
            </div>
          ) : isOfficeFile ? (
            <OfficePreview node={activeNode} />
          ) : (
            <NoteEditor node={activeNode} />
          )}
        </main>
      </div>

      <SearchModal />
      <MigrationModal />
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { NodeMeta, NodeType } from '@yunshu/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { ConfirmDialog } from './AppDialog';

function TrashNodeIcon({ type }: { type: NodeType }) {
  switch (type) {
    case 'folder':
      return <Folder className="w-4 h-4 text-amber-500 shrink-0" />;
    case 'markdown':
      return <FileCode2 className="w-4 h-4 text-purple-600 shrink-0" />;
    case 'docx':
      return <FileText className="w-4 h-4 text-blue-600 shrink-0" />;
    case 'xlsx':
      return <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />;
    case 'pdf':
      return <FileText className="w-4 h-4 text-red-600 shrink-0" />;
    default:
      return <FileText className="w-4 h-4 text-slate-500 shrink-0" />;
  }
}

function parseServerDate(raw: string): Date {
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

function formatDeletedTime(raw?: string | null): string {
  if (!raw) return '刚刚';
  const d = parseServerDate(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const TrashDrawer: React.FC = () => {
  const trashOpen = useAppStore((s) => s.trashOpen);
  const setTrashOpen = useAppStore((s) => s.setTrashOpen);
  const isOffline = useAppStore((s) => s.isOffline);
  const loadTree = useAppStore((s) => s.loadTree);
  const selectNode = useAppStore((s) => s.selectNode);
  const showTip = useAppStore((s) => s.showTip);

  const [items, setItems] = useState<NodeMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filterSection, setFilterSection] = useState<'all' | 'notes' | 'docs'>('all');
  const [keyword, setKeyword] = useState('');
  const [permanentTarget, setPermanentTarget] = useState<{ id: string; title: string; childCount: number } | null>(
    null
  );
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTree(true);
      setItems(res.nodes);
    } catch (err) {
      showTip(err instanceof Error ? err.message : '加载回收站失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showTip]);

  useEffect(() => {
    if (!trashOpen) return;
    setKeyword('');
    void fetchTrash();
  }, [trashOpen, fetchTrash]);

  useEffect(() => {
    if (!trashOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !permanentTarget && !emptyConfirmOpen) {
        setTrashOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trashOpen, permanentTarget, emptyConfirmOpen, setTrashOpen]);

  // 将整棵被删目录聚合为顶级条目，避免展开大量子项；搜索时支持匹配任意层级
  const { displayItems, childCountMap } = useMemo(() => {
    const idSet = new Set(items.map((n) => n.id));
    const countMap = new Map<string, number>();

    for (const n of items) {
      for (const other of items) {
        if (other.id !== n.id && other.path.startsWith(n.path)) {
          countMap.set(n.id, (countMap.get(n.id) ?? 0) + 1);
        }
      }
    }

    const q = keyword.trim().toLowerCase();
    const baseList = q
      ? items.filter((n) => n.title.toLowerCase().includes(q))
      : items.filter((n) => !n.parentId || !idSet.has(n.parentId));

    const filtered = baseList.filter((n) => {
      if (filterSection === 'all') return true;
      return (n.section === 'docs' ? 'docs' : 'notes') === filterSection;
    });

    return { displayItems: filtered, childCountMap: countMap };
  }, [items, filterSection, keyword]);

  if (!trashOpen) return null;

  const handleRestore = async (item: NodeMeta) => {
    setBusyId(item.id);
    try {
      const res = await api.restoreNode(item.id);
      await Promise.all([loadTree(), fetchTrash()]);
      selectNode(item.id);
      showTip(
        res.movedToRoot
          ? `已恢复「${item.title}」（原目录不存在，已移至根目录）`
          : `已恢复「${item.title}」`
      );
    } catch (err) {
      showTip(err instanceof Error ? err.message : '恢复失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmPermanentDelete = async () => {
    if (!permanentTarget) return;
    const target = permanentTarget;
    setPermanentTarget(null);
    setBusyId(target.id);
    try {
      await api.permanentDeleteNode(target.id);
      await fetchTrash();
      showTip(`已彻底删除「${target.title}」`);
    } catch (err) {
      showTip(err instanceof Error ? err.message : '彻底删除失败', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmEmpty = async () => {
    setEmptyConfirmOpen(false);
    setLoading(true);
    try {
      const res = await api.emptyTrash();
      setItems([]);
      showTip(`已清空回收站（共删除 ${res.deletedCount} 项）`);
    } catch (err) {
      showTip(err instanceof Error ? err.message : '清空回收站失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] flex justify-end"
      onClick={() => setTrashOpen(false)}
    >
      <div
        className="w-full sm:w-[480px] lg:w-[540px] max-w-[96vw] h-full bg-white dark:bg-neutral-950 border-l border-slate-200 dark:border-neutral-800 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-2 bg-slate-50/70 dark:bg-black shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Trash2 className="w-4 h-4 text-red-500 shrink-0" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">回收站</h3>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-neutral-900 text-slate-500 dark:text-slate-400">
              {items.length} 项
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={loading || isOffline}
              onClick={() => void fetchTrash()}
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-neutral-900 disabled:opacity-40"
              title="刷新回收站"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {items.length > 0 && (
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setEmptyConfirmOpen(true)}
                className="px-2.5 py-1 text-xs font-medium rounded-md text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/70 hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-40"
              >
                清空回收站
              </button>
            )}
            <button
              type="button"
              onClick={() => setTrashOpen(false)}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-neutral-900"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 筛选与搜索栏 */}
        <div className="px-4 py-2.5 border-b border-slate-200 dark:border-neutral-800 flex items-center gap-2 bg-white dark:bg-black shrink-0">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索已删除的笔记、文档或目录..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-neutral-900 text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center p-0.5 rounded-md bg-slate-100 dark:bg-neutral-900 border border-slate-200 dark:border-neutral-800 text-[11px] shrink-0">
            {(
              [
                ['all', '全部'],
                ['notes', '笔记'],
                ['docs', '文档'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterSection(key)}
                className={`px-2 py-1 rounded transition-colors ${
                  filterSection === key
                    ? 'bg-white dark:bg-black text-blue-600 dark:text-blue-400 font-semibold shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 列表主体 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50/40 dark:bg-black">
          {isOffline ? (
            <div className="py-16 text-center text-xs text-amber-600 dark:text-amber-400">
              当前处于离线模式，连接服务端后即可管理回收站
            </div>
          ) : loading ? (
            <div className="py-16 text-center text-xs text-slate-400">正在加载回收站...</div>
          ) : displayItems.length === 0 ? (
            <div className="py-20 text-center text-xs text-slate-400 leading-relaxed">
              <Trash2 className="w-9 h-9 mx-auto mb-2.5 text-slate-300 dark:text-neutral-700" />
              {items.length === 0 ? '回收站空空如也' : '没有符合筛选条件的已删除项目'}
            </div>
          ) : (
            displayItems.map((item) => {
              const subCount = childCountMap.get(item.id) ?? 0;
              const isBusy = busyId === item.id;
              return (
                <div
                  key={item.id}
                  className="p-3 rounded-lg border border-slate-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-950 flex items-center justify-between gap-3 hover:border-slate-300 dark:hover:border-neutral-700 transition-colors"
                >
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <div className="mt-0.5">
                      <TrashNodeIcon type={item.nodeType} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                          {item.title}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-neutral-900 text-slate-500 dark:text-slate-400 shrink-0">
                          {item.section === 'docs' ? '文档' : '笔记'}
                        </span>
                        {subCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 shrink-0">
                            含 {subCount} 子项
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-slate-400 mt-1">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span>删除于 {formatDeletedTime(item.deletedAt || item.updatedAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRestore(item)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60 disabled:opacity-50"
                      title="恢复到原目录"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      恢复
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        setPermanentTarget({ id: item.id, title: item.title, childCount: subCount })
                      }
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-50"
                      title="彻底删除（不可恢复）"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(permanentTarget)}
        title="彻底删除"
        description={
          permanentTarget?.childCount
            ? `确定要永久删除「${permanentTarget.title}」及其包含的 ${permanentTarget.childCount} 个子项吗？此操作不可恢复。`
            : `确定要永久删除「${permanentTarget?.title ?? ''}」吗？此操作不可恢复。`
        }
        confirmText="永久删除"
        danger
        onConfirm={handleConfirmPermanentDelete}
        onCancel={() => setPermanentTarget(null)}
      />

      <ConfirmDialog
        open={emptyConfirmOpen}
        title="清空回收站"
        description={`确定要永久删除回收站中的全部 ${items.length} 个项目吗？清空后将无法恢复。`}
        confirmText="确认清空"
        danger
        onConfirm={handleConfirmEmpty}
        onCancel={() => setEmptyConfirmOpen(false)}
      />
    </div>
  );
};

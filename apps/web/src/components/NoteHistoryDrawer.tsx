import React, { useEffect, useMemo, useState } from 'react';
import { Clock, History, RotateCcw, X } from 'lucide-react';
import type { NoteVersionDetail, NoteVersionSummary } from '@yunshu/shared';
import { api } from '../lib/api';
import { parseCanvasHtml, sortBlocksReadingOrder } from '../lib/canvasFormat';
import { ConfirmDialog } from './AppDialog';

interface NoteHistoryDrawerProps {
  open: boolean;
  nodeId: string;
  currentTitle: string;
  onClose: () => void;
  onRestored: (payload: { title: string; contentHtml: string; restoredFromVersion: number }) => void;
}

function parseServerDate(raw: string): Date {
  // SQLite datetime('now') 返回 'YYYY-MM-DD HH:MM:SS'（UTC），转为 ISO UTC 字符串解析为本地时区
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

function formatDateTime(raw: string): string {
  const d = parseServerDate(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatRelativeTime(raw: string): string {
  const d = parseServerDate(raw);
  if (Number.isNaN(d.getTime())) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function sourceLabel(src: NoteVersionSummary['changeSource']): { text: string; cls: string } {
  switch (src) {
    case 'manual':
      return {
        text: '手动同步',
        cls: 'bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300',
      };
    case 'before_restore':
      return {
        text: '恢复前备份',
        cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
      };
    default:
      return {
        text: '自动同步',
        cls: 'bg-slate-100 text-slate-600 dark:bg-neutral-800 dark:text-slate-300',
      };
  }
}

export const NoteHistoryDrawer: React.FC<NoteHistoryDrawerProps> = ({
  open,
  nodeId,
  currentTitle,
  onClose,
  onRestored,
}) => {
  const [loadingList, setLoadingList] = useState(false);
  const [versions, setVersions] = useState<NoteVersionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<NoteVersionDetail | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingList(true);
    setErrorMsg(null);
    setDetail(null);
    setSelectedId(null);

    void (async () => {
      try {
        const res = await api.listNoteVersions(nodeId);
        if (cancelled) return;
        setVersions(res.versions);
        if (res.versions.length > 0) {
          setSelectedId(res.versions[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : '加载版本历史失败');
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, nodeId]);

  useEffect(() => {
    if (!open || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setErrorMsg(null);

    void (async () => {
      try {
        const res = await api.getNoteVersion(nodeId, selectedId);
        if (!cancelled) setDetail(res.version);
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : '加载版本详情失败');
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, nodeId, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmRestoreOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, confirmRestoreOpen, onClose]);

  const previewBlocks = useMemo(() => {
    if (!detail) return [];
    return sortBlocksReadingOrder(parseCanvasHtml(detail.contentHtml || '', 680));
  }, [detail]);

  if (!open) return null;

  const handleConfirmRestore = async () => {
    if (!detail) return;
    const res = await api.restoreNoteVersion(nodeId, detail.id);
    setConfirmRestoreOpen(false);
    onRestored({
      title: res.node.title,
      contentHtml: res.contentHtml,
      restoredFromVersion: res.restoredFromVersion,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-2 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[88vh] rounded-xl bg-white dark:bg-neutral-950 border border-slate-200 dark:border-neutral-800 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0 bg-slate-50/70 dark:bg-black">
          <div className="flex items-center gap-2 min-w-0">
            <History className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              版本历史 · {currentTitle}
            </h3>
            <span className="hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-neutral-900 text-slate-500 dark:text-slate-400 shrink-0">
              最多保留最近 30 天
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-neutral-900"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="mx-4 mt-3 px-3 py-2 text-xs rounded-md bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-900 shrink-0">
            {errorMsg}
          </div>
        )}

        {/* 主体：左侧版本列表 + 右侧历史内容预览 */}
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden">
          {/* 版本时间线 */}
          <div className="w-full sm:w-72 md:w-80 max-h-[34vh] sm:max-h-none border-b sm:border-b-0 sm:border-r border-slate-200 dark:border-neutral-800 overflow-y-auto bg-slate-50/40 dark:bg-black p-2.5 space-y-1.5 shrink-0">
            {loadingList ? (
              <div className="py-10 text-center text-xs text-slate-400">正在加载历史记录...</div>
            ) : versions.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-slate-400 leading-relaxed">
                最近 30 天暂无历史版本
                <br />
                编辑并同步笔记后将自动生成版本快照
              </div>
            ) : (
              versions.map((v, idx) => {
                const isSelected = selectedId === v.id;
                const badge = sourceLabel(v.changeSource);
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedId(v.id)}
                    className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/40'
                        : 'border-slate-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-slate-50 dark:hover:bg-neutral-900'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          v{v.version}
                        </span>
                        {idx === 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300">
                            最新
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-400 shrink-0">
                        {formatRelativeTime(v.createdAt)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span>{formatDateTime(v.createdAt)}</span>
                      <span>·</span>
                      <span>{v.charCount} 字</span>
                    </div>

                    <div className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
                      {v.plainTextPreview || '（空白内容）'}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* 历史版本只读预览区 */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-white dark:bg-black">
            {detail ? (
              <>
                <div className="px-4 sm:px-6 py-3 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-3 flex-wrap shrink-0">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                      {detail.title}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      版本 v{detail.version} · 保存于 {formatDateTime(detail.createdAt)} · 共 {detail.charCount} 字
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmRestoreOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    恢复到此版本
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
                  {previewBlocks.map((blk, i) => (
                    <div
                      key={blk.id || i}
                      className={
                        previewBlocks.length > 1
                          ? 'rounded-lg border border-slate-200 dark:border-neutral-800 p-3.5 bg-slate-50/40 dark:bg-neutral-950'
                          : ''
                      }
                    >
                      {previewBlocks.length > 1 && (
                        <div className="text-[10px] text-slate-400 dark:text-neutral-500 mb-2">
                          文本区域 {i + 1}
                        </div>
                      )}
                      <div
                        className="ProseMirror text-sm text-slate-800 dark:text-slate-200"
                        dangerouslySetInnerHTML={{
                          __html: blk.html || '<p style="color:#94a3b8">（空文本区域）</p>',
                        }}
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
                {loadingDetail ? '正在加载版本预览...' : '请在左侧选择要查看的历史版本'}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRestoreOpen}
        title={`恢复到版本 v${detail?.version ?? ''}`}
        description="确定将当前笔记恢复为所选历史版本吗？恢复前系统会自动备份当前内容，随时可以再次切回。"
        confirmText="确认恢复"
        onConfirm={handleConfirmRestore}
        onCancel={() => setConfirmRestoreOpen(false)}
      />
    </div>
  );
};

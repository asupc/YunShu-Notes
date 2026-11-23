import React, { useEffect, useState } from 'react';
import { Cloud, FileArchive, Pause, X } from 'lucide-react';
import type { ImportJobState } from '@yunshu/shared';
import { api, isTauriRuntime, tauriInvoke } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

export const MigrationModal: React.FC = () => {
  const open = useAppStore((s) => s.migrationOpen);
  const setOpen = useAppStore((s) => s.setMigrationOpen);
  const loadTree = useAppStore((s) => s.loadTree);

  const [source, setSource] = useState<'onepkg' | 'graph'>('onepkg');
  const [graphToken, setGraphToken] = useState('');
  const [onepkgPath, setOnepkgPath] = useState('');
  const [job, setJob] = useState<ImportJobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'paused') return;
    const id = window.setInterval(async () => {
      const res = await api.getMigrationJob(job.id);
      setJob(res.job);
      if (res.job.status === 'done') {
        await loadTree();
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [job, loadTree]);

  if (!open) return null;

  const handleStart = async () => {
    setMsg('');
    setBusy(true);
    try {
      if (source === 'graph') {
        const res = await api.startGraphMigration(graphToken.trim());
        const detail = await api.getMigrationJob(res.jobId);
        setJob(detail.job);
      } else {
        if (isTauriRuntime() && onepkgPath.trim()) {
          const parsed = await tauriInvoke<{
            rootTitle: string;
            pages: Array<{ title: string; folderPath: string[]; level: number; htmlContent: string }>;
          }>('parse_onepkg_file', { filePath: onepkgPath.trim() });
          const res = await api.importOnePkgBatch(parsed);
          setMsg(`本地 .onepkg 导入成功，共迁入 ${res.importedPages} 篇笔记！`);
          await loadTree();
        } else {
          setMsg('提示：本地 .onepkg 二进制高速解析请在 Windows 桌面端使用，或在下方选择导出的 HTML/Markdown 文件批量导入。');
        }
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '启动迁移失败');
    } finally {
      setBusy(false);
    }
  };

  const handleHtmlBatchUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const pages = await Promise.all(
        Array.from(files).map(async (f) => ({
          title: f.name.replace(/\.(html|htm|md)$/i, ''),
          folderPath: ['导出的历史笔记'],
          level: 0,
          htmlContent: await f.text(),
        }))
      );
      const res = await api.importOnePkgBatch({ rootTitle: 'OneNote 历史归档', pages });
      setMsg(`批量导入完成，已创建 ${res.importedPages} 篇笔记！`);
      await loadTree();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const pct = job && job.totalPages > 0 ? Math.round((job.importedPages / job.totalPages) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">OneNote 一键迁移向导</h2>
            <p className="text-xs text-slate-500">支持本地 .onepkg 离线解析与微软 Graph API 后台限流导入</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            type="button"
            onClick={() => setSource('onepkg')}
            className={`p-3.5 rounded-lg border text-left ${
              source === 'onepkg'
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            <FileArchive className="w-5 h-5 text-blue-600 mb-1.5" />
            <div className="text-sm font-semibold">本地 .onepkg / 导出文件</div>
            <div className="text-xs text-slate-500 mt-0.5">极速离线导入，无微软限流</div>
          </button>

          <button
            type="button"
            onClick={() => setSource('graph')}
            className={`p-3.5 rounded-lg border text-left ${
              source === 'graph'
                ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            <Cloud className="w-5 h-5 text-emerald-600 mb-1.5" />
            <div className="text-sm font-semibold">Microsoft Graph API</div>
            <div className="text-xs text-slate-500 mt-0.5">直连云端，内置令牌桶防 429</div>
          </button>
        </div>

        {source === 'onepkg' ? (
          <div className="space-y-3 mb-4">
            {isTauriRuntime() && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  本地 .onepkg 文件绝对路径（Windows）
                </label>
                <input
                  type="text"
                  value={onepkgPath}
                  onChange={(e) => setOnepkgPath(e.target.value)}
                  placeholder="例如：D:\Backup\MyNotebook.onepkg"
                  className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
                />
              </div>
            )}
            <div className="p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg text-center">
              <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                也可直接多选 OneNote 导出的 <code>.html</code> / <code>.md</code> 文件批量入库
              </p>
              <label className="inline-block px-3 py-1.5 text-xs font-medium rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 cursor-pointer">
                选择 HTML / Markdown 文件
                <input
                  type="file"
                  multiple
                  accept=".html,.htm,.md"
                  onChange={handleHtmlBatchUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Microsoft Graph Delegated Access Token（需 Notes.Read 权限）
            </label>
            <textarea
              rows={3}
              value={graphToken}
              onChange={(e) => setGraphToken(e.target.value)}
              placeholder="粘贴从 Graph Explorer 或 OAuth 获取的 Bearer Token..."
              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            />
          </div>
        )}

        {job && (
          <div className="mb-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span>
                状态：<strong>{job.status}</strong>（已迁移 {job.importedPages} / {job.totalPages} 页）
              </span>
              {job.status === 'running' && (
                <button
                  type="button"
                  onClick={() => void api.pauseMigrationJob(job.id)}
                  className="flex items-center gap-1 text-amber-600 hover:underline"
                >
                  <Pause className="w-3 h-3" />
                  暂停
                </button>
              )}
            </div>
            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-600 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {msg && <div className="mb-4 text-xs text-blue-700 dark:text-blue-300">{msg}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-4 py-2 text-xs rounded-md border border-slate-200 dark:border-slate-700"
          >
            关闭
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleStart}
            className="px-4 py-2 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {busy ? '执行中...' : '开始迁移'}
          </button>
        </div>
      </div>
    </div>
  );
};

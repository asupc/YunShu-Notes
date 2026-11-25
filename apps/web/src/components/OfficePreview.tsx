import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Download, ExternalLink, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import type {
  ExcelSheetPreview,
  FileAccessUrls,
  InlineOfficePreview,
  NodeFileVersion,
  NodeMeta,
} from '@yunshu/shared';
import { api, getApiBase, isTauriRuntime, sha256File, tauriInvoke } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

declare global {
  interface Window {
    YunShuAndroid?: {
      openLocalFile: (filePath: string, mimeType: string) => string;
    };
  }
}

interface Props {
  node: NodeMeta;
}

function colIndexToLetter(idx: number): string {
  let n = idx + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ExcelSheetTable: React.FC<{ sheet: ExcelSheetPreview }> = ({ sheet }) => {
  const { mergeMap, skipSet } = useMemo(() => {
    const mMap = new Map<string, { rowSpan: number; colSpan: number }>();
    const sSet = new Set<string>();
    for (const m of sheet.merges) {
      mMap.set(`${m.r},${m.c}`, { rowSpan: m.rowSpan, colSpan: m.colSpan });
      for (let dr = 0; dr < m.rowSpan; dr += 1) {
        for (let dc = 0; dc < m.colSpan; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          sSet.add(`${m.r + dr},${m.c + dc}`);
        }
      }
    }
    return { mergeMap: mMap, skipSet: sSet };
  }, [sheet]);

  const colCount = sheet.rows.reduce((max, r) => Math.max(max, r.length), 0);

  if (sheet.rows.length === 0 || colCount === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-slate-400">
        当前工作表「{sheet.name}」为空
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-white dark:bg-black">
      {sheet.truncated && (
        <div className="px-4 py-1.5 text-[11px] bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-b border-amber-200 dark:border-amber-900">
          该工作表共 {sheet.totalRows} 行 × {sheet.totalCols} 列，在线预览仅展示前 {sheet.rows.length} 行 ×{' '}
          {colCount} 列；完整内容请点击「用本机 Office 打开」查看。
        </div>
      )}
      <table className="border-collapse text-xs w-max min-w-full">
        <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-neutral-900">
          <tr>
            <th className="sticky left-0 z-20 w-10 min-w-[40px] px-2 py-1.5 text-center font-medium text-slate-400 dark:text-neutral-500 border border-slate-200 dark:border-neutral-800 bg-slate-100 dark:bg-neutral-900">
              #
            </th>
            {Array.from({ length: colCount }, (_, c) => (
              <th
                key={c}
                className="px-2.5 py-1.5 text-center font-semibold text-slate-500 dark:text-neutral-400 border border-slate-200 dark:border-neutral-800 min-w-[96px]"
              >
                {colIndexToLetter(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r} className="hover:bg-blue-50/35 dark:hover:bg-neutral-900/70">
              <td className="sticky left-0 z-[5] px-2 py-1.5 text-center text-[11px] font-mono text-slate-400 dark:text-neutral-500 border border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-neutral-950 select-none">
                {r + 1}
              </td>
              {Array.from({ length: colCount }, (_, c) => {
                const key = `${r},${c}`;
                if (skipSet.has(key)) return null;
                const span = mergeMap.get(key);
                const val = row[c] ?? '';
                const isNumeric = val !== '' && /^-?\d+(\.\d+)?%?$/.test(val.replace(/,/g, ''));
                return (
                  <td
                    key={c}
                    rowSpan={span?.rowSpan}
                    colSpan={span?.colSpan}
                    className={`px-2.5 py-1.5 border border-slate-200 dark:border-neutral-800 text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words max-w-[360px] align-top ${
                      r === 0 ? 'font-semibold bg-slate-50/70 dark:bg-neutral-950/80' : ''
                    } ${isNumeric ? 'text-right font-mono' : 'text-left'}`}
                  >
                    {val}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const OfficePreview: React.FC<Props> = ({ node }) => {
  const [fileInfo, setFileInfo] = useState<FileAccessUrls | null>(null);
  const [inlinePreview, setInlinePreview] = useState<InlineOfficePreview | null>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [versions, setVersions] = useState<NodeFileVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const reuploadRef = useRef<HTMLInputElement>(null);

  const syncState = useAppStore((s) => s.officeSyncMap[node.id] ?? 'synced');
  const setOfficeSyncState = useAppStore((s) => s.setOfficeSyncState);
  const loadTree = useAppStore((s) => s.loadTree);
  const showTip = useAppStore((s) => s.showTip);

  const fetchAll = async () => {
    setLoading(true);
    setInlinePreview(null);
    setActiveSheetIdx(0);
    try {
      const [urls, verRes] = await Promise.all([api.getFileUrls(node.id), api.getVersions(node.id)]);
      setFileInfo(urls);
      setVersions(verRes.versions);

      const lower = urls.fileName.toLowerCase();
      const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');
      const isDocx = lower.endsWith('.docx');
      // Excel 优先使用原生多 Sheet 交互表格预览；Word 在无 PDF 预览时回退到内置 HTML 预览
      if (isExcel || (isDocx && !(urls.previewPdfUrl && urls.previewStatus === 'ready'))) {
        try {
          const inline = await api.getInlinePreview(node.id);
          setInlinePreview(inline);
        } catch {
          setInlinePreview(null);
        }
      }
    } catch (err) {
      showTip(err instanceof Error ? err.message : '读取文件信息失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
  }, [node.id, node.currentVersion]);

  const handleOpenLocalOffice = async () => {
    if (!fileInfo) return;
    if (!isTauriRuntime()) {
      window.open(fileInfo.downloadUrl, '_blank');
      showTip('当前为 Web 浏览器模式，已为你下载原文件；在桌面端点击将直接唤起本机 Office 并自动回传。');
      return;
    }
    try {
      setOfficeSyncState(node.id, 'editing_local');
      const localPath = await tauriInvoke<string>('open_office_node', {
        nodeId: node.id,
        fileName: fileInfo.fileName,
        downloadUrl: fileInfo.downloadUrl,
        sha256: fileInfo.sha256,
        baseVersion: fileInfo.version,
        apiBase: getApiBase() || 'http://127.0.0.1:3001',
        authToken: localStorage.getItem('yunshu_token') || '',
      });

      if (window.YunShuAndroid?.openLocalFile) {
        const res = window.YunShuAndroid.openLocalFile(localPath, fileInfo.mimeType || '');
        if (res !== 'OK') {
          throw new Error(res || '安卓端唤起 WPS / Office 失败');
        }
        showTip('已调用本机 WPS / Office 打开文件。保存后若写回原文件将自动同步回云端。');
      } else {
        showTip('已调用本机 Office 打开文件。修改后按 Ctrl+S 保存，将自动回传新版本。');
      }
    } catch (err) {
      setOfficeSyncState(node.id, 'error');
      showTip(err instanceof Error ? err.message : '唤起本机 Office 失败', 'error');
    }
  };

  const handleUploadNewVersion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !fileInfo) return;
    try {
      setOfficeSyncState(node.id, 'uploading');
      const hash = await sha256File(file);
      const mimeType = file.type || fileInfo.mimeType;
      const presign = await api.presignFile({
        nodeId: node.id,
        fileName: file.name,
        fileSize: file.size,
        sha256: hash,
        mimeType,
      });
      if (!presign.alreadyExists && presign.uploadUrl) {
        await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
      }
      try {
        await api.commitFile({
          nodeId: node.id,
          baseVersion: fileInfo.version,
          storageKey: presign.storageKey,
          fileName: file.name,
          mimeType,
          fileSize: file.size,
          sha256: hash,
          deviceName: 'Web 手动上传',
        });
      } catch (err) {
        if ((err as Error & { status?: number }).status === 409) {
          const keepBoth = window.confirm('云端已有更新版本，是否自动另存为「冲突副本」以保留双方改动？');
          if (keepBoth) {
            await api.commitFile({
              nodeId: node.id,
              baseVersion: fileInfo.version,
              storageKey: presign.storageKey,
              fileName: file.name,
              mimeType,
              fileSize: file.size,
              sha256: hash,
              deviceName: 'Web 冲突副本',
              forceConflictCopy: true,
            });
          }
        } else {
          throw err;
        }
      }
      setOfficeSyncState(node.id, 'synced');
      await loadTree();
      await fetchAll();
    } catch (err) {
      setOfficeSyncState(node.id, 'error');
      showTip(err instanceof Error ? err.message : '上传新版本失败', 'error');
    } finally {
      e.target.value = '';
    }
  };

  const handleRestore = async (ver: number) => {
    if (!window.confirm(`确定将版本 v${ver} 恢复为最新版吗？`)) return;
    await api.restoreVersion(node.id, ver);
    await loadTree();
    await fetchAll();
  };

  const currentExcelSheet =
    inlinePreview?.kind === 'excel' ? inlinePreview.sheets[activeSheetIdx] ?? inlinePreview.sheets[0] : null;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <input ref={reuploadRef} type="file" onChange={handleUploadNewVersion} className="hidden" />

      {/* 本机编辑中提示条 */}
      {syncState === 'editing_local' && (
        <div className="px-4 py-1.5 text-xs bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 flex items-center justify-center">
          检测到文件已在外部 Office 打开，修改后按 Ctrl+S 保存将自动同步回云端
        </div>
      )}

      {/* 顶部操作工具栏 */}
      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-3 flex-wrap bg-white dark:bg-black">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-base font-bold truncate text-slate-900 dark:text-slate-100">{node.title}</h2>
          {fileInfo && (
            <span className="px-2 py-0.5 text-xs rounded bg-slate-100 dark:bg-neutral-900 text-slate-600 dark:text-slate-300 font-mono">
              v{fileInfo.version}
            </span>
          )}
          <span
            className={`px-2 py-0.5 text-xs rounded-full font-medium ${
              syncState === 'synced'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : syncState === 'editing_local'
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                : syncState === 'uploading'
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
            }`}
          >
            {syncState === 'synced'
              ? '● 已同步'
              : syncState === 'editing_local'
              ? '● 本机编辑中'
              : syncState === 'uploading'
              ? '● 自动回传中...'
              : '● 需关注'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenLocalOffice}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {isTauriRuntime() ? '用本机 Office 打开' : '下载并用本机打开'}
          </button>

          <button
            type="button"
            onClick={() => reuploadRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-900"
          >
            <Upload className="w-3.5 h-3.5" />
            上传新版
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-900"
          >
            <Clock className="w-3.5 h-3.5" />
            版本历史（{versions.length}）
          </button>

          <button
            type="button"
            onClick={() => void fetchAll()}
            className="p-1.5 rounded-md border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-900"
            title="刷新预览"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 主体：预览画布 + 右侧版本历史抽屉 */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 min-w-0 bg-slate-100 dark:bg-black flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
              正在加载文档预览...
            </div>
          ) : inlinePreview?.kind === 'excel' && currentExcelSheet ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <ExcelSheetTable sheet={currentExcelSheet} />
              {/* 底部多 Sheet 切换标签栏 */}
              <div className="px-3 py-1.5 border-t border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-neutral-950 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
                {inlinePreview.sheets.map((s, idx) => (
                  <button
                    key={`${s.name}-${idx}`}
                    type="button"
                    onClick={() => setActiveSheetIdx(idx)}
                    className={`px-3 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                      idx === activeSheetIdx
                        ? 'bg-white dark:bg-black text-emerald-700 dark:text-emerald-400 border border-slate-200 dark:border-neutral-700 shadow-sm'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-neutral-900'
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          ) : inlinePreview?.kind === 'docx' ? (
            <div className="flex-1 overflow-y-auto p-4 sm:p-8 bg-slate-50 dark:bg-black">
              <div
                className="ProseMirror max-w-4xl mx-auto p-6 sm:p-10 rounded-xl bg-white dark:bg-neutral-950 border border-slate-200 dark:border-neutral-800 shadow-sm text-slate-800 dark:text-slate-200"
                dangerouslySetInnerHTML={{ __html: inlinePreview.html }}
              />
            </div>
          ) : fileInfo?.previewPdfUrl && fileInfo.previewStatus === 'ready' ? (
            <iframe
              src={fileInfo.previewPdfUrl}
              title={fileInfo.fileName}
              className="w-full h-full border-0"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="max-w-md text-center p-8 bg-white dark:bg-black rounded-xl border border-slate-200 dark:border-neutral-800 shadow-sm">
                <p className="text-base font-semibold text-slate-800 dark:text-slate-100 mb-2">
                  {fileInfo?.previewStatus === 'pending'
                    ? '后台正在生成高清 PDF 预览...'
                    : '暂未生成在线预览'}
                </p>
                <p className="text-xs text-slate-500 mb-5">
                  你可以直接点击「用本机 Office 打开」在电脑或安卓端使用 Microsoft Word / Excel / WPS 查看和编辑，保存后自动回传。
                </p>
                {fileInfo && (
                  <a
                    href={fileInfo.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <Download className="w-3.5 h-3.5" />
                    下载原文件（{(fileInfo.fileSize / 1024).toFixed(1)} KB）
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {historyOpen && (
          <div className="w-[290px] shrink-0 border-l border-slate-200 dark:border-neutral-800 bg-white dark:bg-black overflow-y-auto p-4">
            <h3 className="text-sm font-bold mb-3 text-slate-900 dark:text-slate-100">版本历史</h3>
            <div className="space-y-3">
              {versions.map((v, idx) => (
                <div
                  key={v.id}
                  className={`p-3 rounded-lg border text-xs ${
                    idx === 0
                      ? 'border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/40'
                      : 'border-slate-200 dark:border-neutral-800'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-slate-900 dark:text-slate-100">
                      v{v.version} {idx === 0 && '（当前版本）'}
                    </span>
                    {idx > 0 && (
                      <button
                        type="button"
                        onClick={() => handleRestore(v.version)}
                        className="flex items-center gap-0.5 text-blue-600 hover:underline"
                      >
                        <RotateCcw className="w-3 h-3" />
                        恢复
                      </button>
                    )}
                  </div>
                  <div className="text-slate-500">来源：{v.sourceDevice || '未知设备'}</div>
                  <div className="text-slate-500">
                    大小：{(v.fileSize / 1024).toFixed(1)} KB · {new Date(v.createdAt).toLocaleString('zh-CN')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

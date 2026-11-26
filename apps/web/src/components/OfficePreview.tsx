import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Download, Edit3, ExternalLink, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import type {
  ExcelSheetPreview,
  FileAccessUrls,
  InlineOfficePreview,
  NodeFileVersion,
  NodeMeta,
  OnlyOfficeConfigResponse,
} from '@yunshu/shared';
import { api, getApiBase, isTauriRuntime, sha256File, tauriInvoke } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface OnlyOfficeEditorInstance {
  destroyEditor?: () => void;
}

declare global {
  interface Window {
    YunShuAndroid?: {
      openLocalFile: (filePath: string, mimeType: string) => string;
    };
    DocsAPI?: {
      DocEditor: new (placeholderId: string, config: Record<string, unknown>) => OnlyOfficeEditorInstance;
    };
  }
}

const loadedOnlyOfficeScripts = new Map<string, Promise<void>>();
let onlyOfficeInstanceSeq = 0;

function loadOnlyOfficeSdk(documentServerUrl: string): Promise<void> {
  const scriptUrl = `${documentServerUrl.replace(/\/+$/, '')}/web-apps/apps/api/documents/api.js`;
  if (window.DocsAPI?.DocEditor) return Promise.resolve();
  const existing = loadedOnlyOfficeScripts.get(scriptUrl);
  if (existing) return existing;

  const p = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      if (window.DocsAPI?.DocEditor) resolve();
      else reject(new Error('ONLYOFFICE SDK 已加载但未初始化 DocsAPI'));
    };
    script.onerror = () => {
      loadedOnlyOfficeScripts.delete(scriptUrl);
      reject(new Error(`无法连接 ONLYOFFICE 服务（${documentServerUrl}），请检查容器是否已启动`));
    };
    document.head.appendChild(script);
  });
  loadedOnlyOfficeScripts.set(scriptUrl, p);
  return p;
}

interface Props {
  node: NodeMeta;
  headerMetaSlot?: HTMLDivElement | null;
  headerActionsSlot?: HTMLDivElement | null;
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
          {colCount} 列；完整内容请点击「在线编辑」或「用本机 Office 打开」查看。
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

export const OfficePreview: React.FC<Props> = ({ node, headerMetaSlot, headerActionsSlot }) => {
  const [fileInfo, setFileInfo] = useState<FileAccessUrls | null>(null);
  const [inlinePreview, setInlinePreview] = useState<InlineOfficePreview | null>(null);
  const [onlyOfficeCfg, setOnlyOfficeCfg] = useState<OnlyOfficeConfigResponse | null>(null);
  const [onlyOfficeEditing, setOnlyOfficeEditing] = useState(false);
  const [onlyOfficeLoading, setOnlyOfficeLoading] = useState(false);
  const [onlyOfficeWaking, setOnlyOfficeWaking] = useState(false);
  const [onlyOfficeWakeHint, setOnlyOfficeWakeHint] = useState('');
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [versions, setVersions] = useState<NodeFileVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const reuploadRef = useRef<HTMLInputElement>(null);
  const ooEditorRef = useRef<OnlyOfficeEditorInstance | null>(null);
  // ONLYOFFICE 的挂载点由我们手动创建，不能交给 React 渲染：
  // 否则 destroyEditor 与 React 卸载都会去删同一个节点，触发 removeChild 报错甚至整页崩溃。
  const ooContainerRef = useRef<HTMLDivElement | null>(null);
  // 打开文档时自动进入在线编辑；用户手动退出后，本次打开期间不再强制进入。
  // 防止快速切换文档时，旧请求返回后覆盖新文档的状态/错误地自动打开旧文档。
  const fetchSeqRef = useRef(0);
  const wakeSeqRef = useRef(0);

  const theme = useAppStore((s) => s.theme);
  const syncState = useAppStore((s) => s.officeSyncMap[node.id] ?? 'synced');
  const setOfficeSyncState = useAppStore((s) => s.setOfficeSyncState);
  const loadTree = useAppStore((s) => s.loadTree);
  const showTip = useAppStore((s) => s.showTip);

  const destroyOnlyOffice = () => {
    if (ooEditorRef.current) {
      try {
        ooEditorRef.current.destroyEditor?.();
      } catch {
        /* ignore */
      }
      ooEditorRef.current = null;
    }
    // 清掉 ONLYOFFICE 自己创建的 DOM，保留空的 React 容器
    if (ooContainerRef.current) {
      ooContainerRef.current.innerHTML = '';
    }
  };

  const fetchAll = async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setInlinePreview(null);
    setActiveSheetIdx(0);
    try {
      const [urls, verRes, ooRes] = await Promise.all([
        api.getFileUrls(node.id),
        api.getVersions(node.id),
        api.getOnlyOfficeConfig(node.id, theme).catch(() => ({ enabled: false }) as OnlyOfficeConfigResponse),
      ]);
      if (seq !== fetchSeqRef.current) return;
      setFileInfo(urls);
      setVersions(verRes.versions);
      setOnlyOfficeCfg(ooRes);

      // 文档默认以查看模式打开（零依赖预览 / PDF），不主动唤醒 ONLYOFFICE 容器；
      // 仅当用户主动点击「在线编辑」时才按需唤醒并进入编辑态。
      const lower = urls.fileName.toLowerCase();
      const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');
      const isDocx = lower.endsWith('.docx');
      if (isExcel || (isDocx && !(urls.previewPdfUrl && urls.previewStatus === 'ready'))) {
        try {
          const inline = await api.getInlinePreview(node.id);
          if (seq !== fetchSeqRef.current) return;
          setInlinePreview(inline);
        } catch {
          if (seq === fetchSeqRef.current) setInlinePreview(null);
        }
      }
    } catch (err) {
      if (seq === fetchSeqRef.current) {
        showTip(err instanceof Error ? err.message : '读取文件信息失败', 'error');
      }
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    wakeSeqRef.current += 1;
    destroyOnlyOffice();
    setOnlyOfficeEditing(false);
    setOnlyOfficeWaking(false);
    setOnlyOfficeWakeHint('');
    void fetchAll();
    return () => {
      wakeSeqRef.current += 1;
      destroyOnlyOffice();
    };
  }, [node.id, node.currentVersion]);

  // 在线编辑期间每 60 秒上报一次心跳，防止编辑中途触发空闲自动休眠
  useEffect(() => {
    if (!onlyOfficeEditing) return;
    void api.heartbeatOnlyOffice().catch(() => {});
    const timer = window.setInterval(() => {
      void api.heartbeatOnlyOffice().catch(() => {});
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [onlyOfficeEditing]);

  // 挂载 ONLYOFFICE 编辑器实例
  useEffect(() => {
    if (!onlyOfficeEditing || !onlyOfficeCfg?.enabled || !onlyOfficeCfg.documentServerUrl || !onlyOfficeCfg.config) {
      return;
    }
    let cancelled = false;
    setOnlyOfficeLoading(true);

    void (async () => {
      try {
        await loadOnlyOfficeSdk(onlyOfficeCfg.documentServerUrl!);
        if (cancelled) return;
        destroyOnlyOffice();
        const container = ooContainerRef.current;
        if (!container || !window.DocsAPI?.DocEditor) return;
        // 在 React 容器里再放一个完全由 ONLYOFFICE 接管的子节点
        const holder = document.createElement('div');
        holder.id = `yunshu-onlyoffice-editor-${++onlyOfficeInstanceSeq}`;
        holder.className = 'w-full h-full';
        container.appendChild(holder);
        ooEditorRef.current = new window.DocsAPI.DocEditor(holder.id, onlyOfficeCfg.config!);
      } catch (err) {
        if (!cancelled) {
          showTip(err instanceof Error ? err.message : '加载 ONLYOFFICE 编辑器失败', 'error');
          setOnlyOfficeEditing(false);
        }
      } finally {
        if (!cancelled) setOnlyOfficeLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      destroyOnlyOffice();
    };
  }, [onlyOfficeEditing, onlyOfficeCfg, showTip]);

  const handleToggleOnlyOffice = async () => {
    if (onlyOfficeEditing || onlyOfficeWaking) {
      wakeSeqRef.current += 1;
      destroyOnlyOffice();
      setOnlyOfficeEditing(false);
      setOnlyOfficeWaking(false);
      setOnlyOfficeWakeHint('');
      // 退出编辑回到默认查看模式，稍等回调落盘后刷新最新版本与预览
      window.setTimeout(() => {
        void loadTree();
        void fetchAll();
      }, 600);
      return;
    }

    const mySeq = ++wakeSeqRef.current;
    try {
      setHistoryOpen(false);
      setOnlyOfficeWaking(true);
      setOnlyOfficeWakeHint('正在检测 ONLYOFFICE 引擎状态...');

      let status = await api.wakeOnlyOffice();
      if (mySeq !== wakeSeqRef.current) return;
      if (status.state === 'unavailable') {
        throw new Error(status.message || 'ONLYOFFICE 服务暂不可用');
      }

      if (status.state !== 'ready') {
        setOnlyOfficeWakeHint(
          status.message ||
            `正在按需唤醒 ONLYOFFICE 引擎（预计 20–40 秒），空闲 ${status.idleMinutes} 分钟后将自动休眠释放内存...`
        );
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 2000));
          if (mySeq !== wakeSeqRef.current) return;
          status = await api.getOnlyOfficeStatus();
          if (mySeq !== wakeSeqRef.current) return;
          if (status.state === 'ready') break;
          if (status.state === 'unavailable') {
            throw new Error(status.message || 'ONLYOFFICE 启动失败');
          }
        }
        if (status.state !== 'ready') {
          throw new Error('等待 ONLYOFFICE 启动超时，请稍后重试');
        }
      }

      const latestCfg = await api.getOnlyOfficeConfig(node.id, theme);
      if (mySeq !== wakeSeqRef.current) return;
      if (!latestCfg.enabled || !latestCfg.documentServerUrl || !latestCfg.config) {
        throw new Error(latestCfg.reason || '服务端尚未配置 ONLYOFFICE_URL');
      }

      setOnlyOfficeCfg(latestCfg);
      setOnlyOfficeWaking(false);
      setOnlyOfficeWakeHint('');
      setOnlyOfficeEditing(true);
    } catch (err) {
      if (mySeq !== wakeSeqRef.current) return;
      setOnlyOfficeWaking(false);
      setOnlyOfficeWakeHint('');
      showTip(err instanceof Error ? err.message : '启动 ONLYOFFICE 在线编辑失败', 'error');
    }
  };

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
      {syncState === 'editing_local' && !onlyOfficeEditing && (
        <div className="px-4 py-1.5 text-xs bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 flex items-center justify-center">
          检测到文件已在外部 Office 打开，修改后按 Ctrl+S 保存将自动同步回云端
        </div>
      )}

      {/* 顶部元信息（版本号与同步状态）合并到全局顶栏文件名右侧，不再重复显示文件名 */}
      {headerMetaSlot &&
        createPortal(
          <>
            {fileInfo && (
              <span className="px-1.5 py-0.5 text-[11px] rounded bg-slate-100 dark:bg-neutral-900 text-slate-600 dark:text-slate-300 font-mono">
                v{fileInfo.version}
              </span>
            )}
            <span
              className={`hidden md:inline-flex px-2 py-0.5 text-[11px] rounded-full font-medium whitespace-nowrap ${
                onlyOfficeEditing
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : syncState === 'synced'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : syncState === 'editing_local'
                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  : syncState === 'uploading'
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
              }`}
            >
              {onlyOfficeEditing
                ? '● 在线编辑中'
                : syncState === 'synced'
                ? '● 已同步'
                : syncState === 'editing_local'
                ? '● 本机编辑中'
                : syncState === 'uploading'
                ? '● 自动回传中...'
                : '● 需关注'}
            </span>
          </>,
          headerMetaSlot
        )}

      {/* 文档操作按钮统一移至全局顶栏「同步状态」左侧 */}
      {headerActionsSlot &&
        createPortal(
          <>
            {onlyOfficeCfg?.enabled && (
              <button
                type="button"
                onClick={() => void handleToggleOnlyOffice()}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded text-white whitespace-nowrap ${
                  onlyOfficeEditing || onlyOfficeWaking
                    ? 'bg-slate-700 hover:bg-slate-800 dark:bg-neutral-800 dark:hover:bg-neutral-700'
                    : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
                title={
                  onlyOfficeEditing
                    ? '退出在线编辑并返回查看模式'
                    : '使用 ONLYOFFICE Docs 在线编辑（Ctrl+S 自动保存新版本）'
                }
              >
                {onlyOfficeEditing || onlyOfficeWaking ? (
                  <>
                    <X className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{onlyOfficeWaking ? '取消唤醒' : '返回查看'}</span>
                  </>
                ) : (
                  <>
                    <Edit3 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">在线编辑</span>
                  </>
                )}
              </button>
            )}

            {!onlyOfficeEditing && !onlyOfficeWaking && (
              <>
                <button
                  type="button"
                  onClick={handleOpenLocalOffice}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
                  title={isTauriRuntime() ? '用本机 Office 打开' : '下载并用本机打开'}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">
                    {isTauriRuntime() ? '用本机 Office 打开' : '下载并用本机打开'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => reuploadRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-slate-100 dark:hover:bg-neutral-800 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                  title="上传新版本"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span className="hidden lg:inline">上传新版</span>
                </button>

                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-slate-100 dark:hover:bg-neutral-800 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                  title={`版本历史（${versions.length}）`}
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span className="hidden lg:inline">版本历史（{versions.length}）</span>
                </button>

                <button
                  type="button"
                  onClick={() => void fetchAll()}
                  className="p-1 rounded border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-slate-100 dark:hover:bg-neutral-800 text-slate-700 dark:text-slate-200"
                  title="刷新预览"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            <div className="hidden sm:block h-4 w-px bg-slate-200 dark:bg-neutral-800 mx-0.5" />
          </>,
          headerActionsSlot
        )}

      {/* 主体：ONLYOFFICE 在线编辑器 或 预览画布 + 右侧版本历史抽屉 */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* 编辑器容器始终挂载，退出编辑时只销毁内部实例并隐藏：
            避免 React 卸载与 ONLYOFFICE 自己清理 DOM 相互抢节点。 */}
        <div
          className={`relative flex-1 min-w-0 h-full bg-white dark:bg-black ${
            onlyOfficeEditing ? '' : 'hidden'
          }`}
        >
          {onlyOfficeLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 dark:bg-black/80 text-xs text-slate-500">
              正在加载 ONLYOFFICE 在线编辑器...
            </div>
          )}
          <div ref={ooContainerRef} className="w-full h-full" />
        </div>

        {onlyOfficeWaking && !onlyOfficeEditing && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-black">
            <RefreshCw className="w-7 h-7 text-emerald-600 dark:text-emerald-400 animate-spin mb-3" />
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              正在按需启动 ONLYOFFICE 在线编辑引擎...
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-md leading-relaxed">
              {onlyOfficeWakeHint || '首次唤醒约需 20–40 秒，启动就绪后将自动打开编辑器。'}
            </p>
          </div>
        )}

        {!onlyOfficeEditing && !onlyOfficeWaking && (
          <div className="flex-1 min-w-0 bg-slate-100 dark:bg-black flex flex-col overflow-hidden">
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
                正在加载文档预览...
              </div>
            ) : inlinePreview?.kind === 'excel' && currentExcelSheet ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <ExcelSheetTable sheet={currentExcelSheet} />
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
                    你可以下载原文件，或在桌面端点击「用本机 Office 打开」查看和编辑，保存后自动回传。
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
        )}

        {historyOpen && !onlyOfficeEditing && (
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

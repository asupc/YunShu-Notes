import React, { useEffect, useRef, useState } from 'react';
import { Clock, Download, ExternalLink, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import type { FileAccessUrls, NodeFileVersion, NodeMeta } from '@yunshu/shared';
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

export const OfficePreview: React.FC<Props> = ({ node }) => {
  const [fileInfo, setFileInfo] = useState<FileAccessUrls | null>(null);
  const [versions, setVersions] = useState<NodeFileVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const reuploadRef = useRef<HTMLInputElement>(null);

  const syncState = useAppStore((s) => s.officeSyncMap[node.id] ?? 'synced');
  const setOfficeSyncState = useAppStore((s) => s.setOfficeSyncState);
  const loadTree = useAppStore((s) => s.loadTree);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [urls, verRes] = await Promise.all([api.getFileUrls(node.id), api.getVersions(node.id)]);
      setFileInfo(urls);
      setVersions(verRes.versions);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '读取文件信息失败');
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
      setMessage('当前为 Web 浏览器模式，已为你下载原文件；在 Windows 桌面端点击将直接唤起本机 Office 并在 Ctrl+S 保存后自动回传。');
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
        setMessage('已调用本机 WPS / Office 打开文件。保存后若写回原文件将自动同步回云端。');
      } else {
        setMessage('已调用本机 Office 打开文件。修改后按 Ctrl+S 保存，将自动回传新版本。');
      }
    } catch (err) {
      setOfficeSyncState(node.id, 'error');
      setMessage(err instanceof Error ? err.message : '唤起本机 Office 失败');
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
      alert(err instanceof Error ? err.message : '上传新版本失败');
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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <input ref={reuploadRef} type="file" onChange={handleUploadNewVersion} className="hidden" />

      {/* 本机编辑中提示条 */}
      {syncState === 'editing_local' && (
        <div className="px-4 py-1.5 text-xs bg-amber-50 border-b border-amber-200 text-amber-800 flex items-center justify-center">
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
                ? 'bg-emerald-50 text-emerald-700'
                : syncState === 'editing_local'
                ? 'bg-amber-50 text-amber-700'
                : syncState === 'uploading'
                ? 'bg-blue-50 text-blue-700'
                : 'bg-red-50 text-red-700'
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

      {message && (
        <div className="px-4 py-2 text-xs bg-slate-50 dark:bg-black border-b border-slate-200 dark:border-neutral-800 text-slate-600 dark:text-slate-300">
          {message}
        </div>
      )}

      {/* 主体：预览画布 + 右侧版本历史抽屉 */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 bg-slate-100 dark:bg-black flex items-center justify-center overflow-hidden">
          {loading ? (
            <div className="text-sm text-slate-500">正在加载文档预览...</div>
          ) : fileInfo?.previewPdfUrl && fileInfo.previewStatus === 'ready' ? (
            <iframe
              src={fileInfo.previewPdfUrl}
              title={fileInfo.fileName}
              className="w-full h-full border-0"
            />
          ) : (
            <div className="max-w-md text-center p-8 bg-white dark:bg-black rounded-xl border border-slate-200 dark:border-neutral-800 shadow-sm">
              <p className="text-base font-semibold text-slate-800 dark:text-slate-100 mb-2">
                {fileInfo?.previewStatus === 'pending'
                  ? '后台正在生成高清 PDF 预览...'
                  : '暂未生成在线预览'}
              </p>
              <p className="text-xs text-slate-500 mb-5">
                你可以直接点击「用本机 Office 打开」在电脑端使用 Microsoft Word / Excel / WPS 查看和编辑，保存后自动回传。
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

import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Edit3,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pin,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NodeMeta, NodeType } from '@yunshu/shared';
import { api, sha256File } from '../lib/api';
import { markdownToHtml } from '../lib/markdown';
import { useAppStore } from '../store/useAppStore';
import { ConfirmDialog, RenameDialog } from './AppDialog';

function LargeNodeIcon({ type }: { type: NodeType }) {
  switch (type) {
    case 'folder':
      return (
        <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/40 flex items-center justify-center">
          <Folder className="w-7 h-7 text-amber-500 dark:text-amber-400" />
        </div>
      );
    case 'markdown':
      return (
        <div className="w-14 h-14 rounded-2xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200/70 dark:border-purple-800/40 flex items-center justify-center">
          <FileCode2 className="w-7 h-7 text-purple-600 dark:text-purple-400" />
        </div>
      );
    case 'docx':
      return (
        <div className="w-14 h-14 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-800/40 flex items-center justify-center">
          <FileText className="w-7 h-7 text-blue-600 dark:text-blue-400" />
        </div>
      );
    case 'xlsx':
      return (
        <div className="w-14 h-14 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/70 dark:border-emerald-800/40 flex items-center justify-center">
          <FileSpreadsheet className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
        </div>
      );
    case 'pdf':
      return (
        <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200/70 dark:border-red-800/40 flex items-center justify-center">
          <FileText className="w-7 h-7 text-red-600 dark:text-red-400" />
        </div>
      );
    default:
      return (
        <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-neutral-900 border border-slate-200/80 dark:border-neutral-800 flex items-center justify-center">
          <FileText className="w-7 h-7 text-slate-600 dark:text-slate-300" />
        </div>
      );
  }
}

function getTypeLabel(type: NodeType): string {
  switch (type) {
    case 'folder':
      return '目录';
    case 'markdown':
      return 'Markdown';
    case 'docx':
      return 'Word 文档';
    case 'xlsx':
      return 'Excel 表格';
    case 'pdf':
      return 'PDF 文档';
    default:
      return '笔记';
  }
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) return `${mm}-${dd}`;
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const FolderGridView: React.FC<{ folder: NodeMeta }> = ({ folder }) => {
  const nodes = useAppStore((s) => s.nodes);
  const expandedIds = useAppStore((s) => s.expandedIds);
  const selectNode = useAppStore((s) => s.selectNode);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const loadTree = useAppStore((s) => s.loadTree);
  const showTip = useAppStore((s) => s.showTip);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);



  const isDocsFolder = folder.section === 'docs';

  // 当前目录的直接子节点（仅同分区）：目录优先，置顶优先，其次按 rank 排序
  const children = useMemo(() => {
    return nodes
      .filter((n) => n.parentId === folder.id && n.section === folder.section)
      .sort((a, b) => {
        if (a.nodeType === 'folder' && b.nodeType !== 'folder') return -1;
        if (a.nodeType !== 'folder' && b.nodeType === 'folder') return 1;
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return a.rank.localeCompare(b.rank);
      });
  }, [nodes, folder.id]);

  // 统计每个子目录包含的直接子项数
  const childCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) {
      if (n.parentId) {
        map.set(n.parentId, (map.get(n.parentId) ?? 0) + 1);
      }
    }
    return map;
  }, [nodes]);

  const parentFolder = useMemo(
    () => (folder.parentId ? nodes.find((n) => n.id === folder.parentId) ?? null : null),
    [nodes, folder.parentId]
  );

  const handleCreate = async (nodeType: NodeType) => {
    const defaultTitle =
      nodeType === 'folder' ? '新建目录' : nodeType === 'markdown' ? '未命名 Markdown' : '未命名笔记';
    const res = await api.createNode({ parentId: folder.id, title: defaultTitle, nodeType, section: folder.section });
    await loadTree();
    if (!expandedIds[folder.id]) toggleExpand(folder.id);
    selectNode(res.node.id);
  };

  const uploadFilesHere = async (files: FileList | File[], targetFolderId: string) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
          const text = await file.text();
          const html = markdownToHtml(text);
          await api.createNode({
            parentId: isDocsFolder ? null : targetFolderId,
            title: file.name.replace(/\.(md|markdown)$/i, ''),
            nodeType: 'markdown',
            section: 'notes',
            contentHtml: html,
            plainText: text,
          });
          continue;
        }

        const nodeType: NodeType =
          lower.endsWith('.xlsx') || lower.endsWith('.xls')
            ? 'xlsx'
            : lower.endsWith('.pdf')
            ? 'pdf'
            : 'docx';

        const created = await api.createNode({
          parentId: isDocsFolder ? targetFolderId : null,
          title: file.name,
          nodeType,
          section: 'docs',
        });

        const hash = await sha256File(file);
        const mimeType = file.type || 'application/octet-stream';
        const presign = await api.presignFile({
          nodeId: created.node.id,
          fileName: file.name,
          fileSize: file.size,
          sha256: hash,
          mimeType,
        });

        if (!presign.alreadyExists && presign.uploadUrl) {
          await fetch(presign.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            body: file,
          });
        }

        await api.commitFile({
          nodeId: created.node.id,
          baseVersion: 0,
          storageKey: presign.storageKey,
          fileName: file.name,
          mimeType,
          fileSize: file.size,
          sha256: hash,
          deviceName: '桌面/Web 端',
        });
      }
      await loadTree();
      if (!expandedIds[targetFolderId]) toggleExpand(targetFolderId);
      showTip(`已成功上传 ${list.length} 个文件`);
    } catch (err) {
      showTip(err instanceof Error ? err.message : '上传文件失败', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleOpenItem = (item: NodeMeta) => {
    if (!expandedIds[folder.id]) toggleExpand(folder.id);
    if (item.nodeType === 'folder' && !expandedIds[item.id]) {
      toggleExpand(item.id);
    }
    selectNode(item.id);
  };

  const handleConfirmRename = async (nextTitle: string) => {
    if (!renameTarget) return;
    if (nextTitle !== renameTarget.title) {
      await api.updateNode(renameTarget.id, { title: nextTitle });
      await loadTree();
    }
    setRenameTarget(null);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    await api.deleteNode(deleteTarget.id);
    setDeleteTarget(null);
    await loadTree();
  };

  return (
    <div
      className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-white dark:bg-black transition-colors ${
        dragOver ? 'ring-2 ring-inset ring-emerald-500 bg-emerald-50/30 dark:bg-emerald-950/15' : ''
      }`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          void uploadFilesHere(e.dataTransfer.files, folder.id);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.docx,.doc,.xlsx,.xls,.pdf"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void uploadFilesHere(e.target.files, folder.id);
          }
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* 顶部目录信息与快捷操作栏 */}
      <div className="px-4 sm:px-6 py-3 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-3 flex-wrap bg-white dark:bg-black shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {parentFolder && (
            <button
              type="button"
              onClick={() => selectNode(parentFolder.id)}
              className="p-1.5 rounded-md border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-900 text-slate-600 dark:text-slate-300 shrink-0"
              title={`返回上级目录「${parentFolder.title}」`}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <FolderOpen className="w-5 h-5 text-amber-500 dark:text-amber-400 shrink-0" />
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate">
            {folder.title}
          </h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-neutral-900 text-slate-500 dark:text-slate-400 shrink-0">
            {children.length} 项
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs shrink-0">
          {!isDocsFolder ? (
            <button
              type="button"
              onClick={() => void handleCreate('note')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              新建笔记
            </button>
          ) : (
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {uploading ? '上传中...' : '上传文档'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleCreate('folder')}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-slate-100 dark:hover:bg-neutral-800 text-slate-700 dark:text-slate-200"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            新建子目录
          </button>
        </div>
      </div>

      {/* 图标视图网格区 */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {children.length === 0 ? (
          <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center text-slate-400">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-neutral-900 flex items-center justify-center mb-3">
              <FolderOpen className="w-8 h-8 text-slate-400 dark:text-slate-500" />
            </div>
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">当前目录暂无笔记或文档</p>
            <p className="text-xs text-slate-400 mt-1">
              点击上方按钮新建，或直接将本地文档拖入此区域上传
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3.5">
            {children.map((item) => {
              const subCount = item.nodeType === 'folder' ? childCountMap.get(item.id) ?? 0 : 0;
              return (
                <div
                  key={item.id}
                  onClick={() => handleOpenItem(item)}
                  title={item.title}
                  className="group relative flex flex-col items-center text-center p-4 rounded-xl border border-slate-200/80 dark:border-neutral-800 bg-slate-50/60 dark:bg-neutral-950 hover:bg-white dark:hover:bg-neutral-900 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-sm cursor-pointer transition-all select-none"
                >
                  {/* 置顶标记 */}
                  {item.isPinned && (
                    <Pin className="w-3.5 h-3.5 text-amber-500 absolute top-2.5 left-2.5" />
                  )}

                  {/* 右上角悬浮快捷操作（绝对定位不占布局） */}
                  <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameTarget({ id: item.id, title: item.title });
                      }}
                      className="p-1 rounded bg-white/90 dark:bg-neutral-800/90 hover:bg-slate-200 dark:hover:bg-neutral-700 text-slate-500 dark:text-slate-300"
                      title="重命名"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget({ id: item.id, title: item.title });
                      }}
                      className="p-1 rounded bg-white/90 dark:bg-neutral-800/90 hover:bg-red-100 dark:hover:bg-red-950/70 text-slate-500 hover:text-red-600"
                      title="移至回收站"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {/* 大图标 */}
                  <div className="mt-1 mb-3">
                    <LargeNodeIcon type={item.nodeType} />
                  </div>

                  {/* 标题 */}
                  <div className="w-full text-[13px] font-medium text-slate-800 dark:text-slate-100 line-clamp-2 break-all leading-snug min-h-[2.25rem]">
                    {item.title}
                  </div>

                  {/* 副信息：类型 / 子项数 / 更新日期 */}
                  <div className="mt-1.5 text-[11px] text-slate-400 dark:text-neutral-500 flex items-center justify-center gap-1.5">
                    <span>
                      {item.nodeType === 'folder' ? `${subCount} 项` : getTypeLabel(item.nodeType)}
                    </span>
                    {item.updatedAt && (
                      <>
                        <span>·</span>
                        <span>{formatShortDate(item.updatedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <RenameDialog
        open={Boolean(renameTarget)}
        initialValue={renameTarget?.title ?? ''}
        title="重命名节点"
        onConfirm={handleConfirmRename}
        onCancel={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="移至回收站"
        description={`确定要将「${deleteTarget?.title ?? ''}」及其全部子项移入回收站吗？`}
        confirmText="确认移入"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};

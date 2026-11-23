import React, { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderPlus,
  LogOut,
  Moon,
  Plus,
  Search,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NodeTreeItem, NodeType } from '@yunshu/shared';
import { api, sha256File } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

function NodeIcon({ type }: { type: NodeType }) {
  switch (type) {
    case 'folder':
      return <Folder className="w-4 h-4 text-slate-500 shrink-0" />;
    case 'markdown':
      return <FileCode2 className="w-4 h-4 text-purple-600 shrink-0" />;
    case 'docx':
      return <FileText className="w-4 h-4 text-blue-600 shrink-0" />;
    case 'xlsx':
      return <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />;
    case 'pdf':
      return <FileText className="w-4 h-4 text-red-600 shrink-0" />;
    default:
      return <FileText className="w-4 h-4 text-slate-600 shrink-0" />;
  }
}

export const SidebarTree: React.FC = () => {
  const tree = useAppStore((s) => s.tree);
  const activeNodeId = useAppStore((s) => s.activeNodeId);
  const expandedIds = useAppStore((s) => s.expandedIds);
  const theme = useAppStore((s) => s.theme);
  const selectNode = useAppStore((s) => s.selectNode);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const loadTree = useAppStore((s) => s.loadTree);
  const setTheme = useAppStore((s) => s.setTheme);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const setMigrationOpen = useAppStore((s) => s.setMigrationOpen);
  const setUser = useAppStore((s) => s.setUser);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);

  const handleCreate = async (nodeType: NodeType, parentId: string | null = null) => {
    const defaultTitle =
      nodeType === 'folder' ? '新建目录' : nodeType === 'markdown' ? '未命名 Markdown' : '未命名笔记';
    const res = await api.createNode({ parentId, title: defaultTitle, nodeType });
    await loadTree();
    if (parentId && !expandedIds[parentId]) toggleExpand(parentId);
    selectNode(res.node.id);
  };

  const triggerUpload = (parentId: string | null = null) => {
    uploadParentRef.current = parentId;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        const parentId = uploadParentRef.current;

        // Markdown 文件直接导入为原生可编辑节点
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
          const text = await file.text();
          const html = text
            .split('\n')
            .map((line) => (line.trim() ? `<p>${line.replace(/</g, '&lt;')}</p>` : '<p></p>'))
            .join('');
          const created = await api.createNode({
            parentId,
            title: file.name.replace(/\.(md|markdown)$/i, ''),
            nodeType: 'markdown',
            contentHtml: html,
            plainText: text,
          });
          await loadTree();
          selectNode(created.node.id);
          continue;
        }

        const nodeType: NodeType = lower.endsWith('.xlsx') || lower.endsWith('.xls')
          ? 'xlsx'
          : lower.endsWith('.pdf')
          ? 'pdf'
          : 'docx';

        const created = await api.createNode({
          parentId,
          title: file.name,
          nodeType,
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
          deviceName: 'Web 浏览器',
        });

        await loadTree();
        selectNode(created.node.id);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '上传文件失败');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    if (!window.confirm(`确定将「${title}」及其子项移入回收站吗？`)) return;
    await api.deleteNode(id);
    if (activeNodeId === id) selectNode(null);
    await loadTree();
  };

  const handleDropOnNode = async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetId(null);
    if (!dragId || dragId === targetId) return;
    try {
      await api.moveNode(dragId, { newParentId: targetId });
      if (!expandedIds[targetId]) toggleExpand(targetId);
      await loadTree();
    } catch (err) {
      alert(err instanceof Error ? err.message : '移动节点失败');
    } finally {
      setDragId(null);
    }
  };

  const renderItem = (item: NodeTreeItem, depth: number) => {
    const isExpanded = Boolean(expandedIds[item.id]);
    const isActive = activeNodeId === item.id;
    const isDropTarget = dropTargetId === item.id;
    const hasChildren = item.children.length > 0;

    return (
      <div key={item.id}>
        <div
          draggable
          onDragStart={() => setDragId(item.id)}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTargetId(item.id);
          }}
          onDragLeave={() => setDropTargetId(null)}
          onDrop={(e) => handleDropOnNode(e, item.id)}
          onClick={() => selectNode(item.id)}
          style={{ paddingLeft: `${depth * 16 + 10}px` }}
          className={`group flex items-center gap-1.5 py-1.5 pr-2 text-[13.5px] cursor-pointer rounded-md mx-1.5 select-none transition-colors ${
            isActive
              ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 font-semibold'
              : 'hover:bg-slate-200/60 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
          } ${isDropTarget ? 'ring-2 ring-blue-500' : ''}`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(item.id);
            }}
            className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-700"
            title={isExpanded ? '折叠子级' : '展开子级'}
          >
            {hasChildren || item.nodeType === 'folder' ? (
              isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )
            ) : (
              <span className="w-3.5" />
            )}
          </button>

          <NodeIcon type={item.nodeType} />
          <span className="truncate flex-1">{item.title}</span>

          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleCreate('note', item.id);
              }}
              className="p-0.5 rounded hover:bg-slate-300/60 dark:hover:bg-slate-700"
              title="新建子笔记"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                triggerUpload(item.id);
              }}
              className="p-0.5 rounded hover:bg-slate-300/60 dark:hover:bg-slate-700"
              title="上传文档到此节点下"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => handleDelete(e, item.id, item.title)}
              className="p-0.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-600"
              title="移至回收站"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {isExpanded && item.children.length > 0 && (
          <div>{item.children.map((child) => renderItem(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-[264px] shrink-0 h-full flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.docx,.doc,.xlsx,.xls,.pdf"
        onChange={handleFileSelected}
        className="hidden"
      />

      {/* 顶部搜索入口 */}
      <div className="p-3 space-y-2 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs text-slate-500 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md hover:border-blue-400"
        >
          <span className="flex items-center gap-1.5">
            <Search className="w-3.5 h-3.5" />
            全局搜索笔记与文档...
          </span>
          <kbd className="px-1 py-0.5 text-[10px] bg-slate-100 dark:bg-slate-700 rounded">Ctrl+K</kbd>
        </button>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => handleCreate('note', null)}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Plus className="w-3.5 h-3.5" />
            笔记
          </button>
          <button
            type="button"
            onClick={() => handleCreate('folder', null)}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            目录
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => triggerUpload(null)}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {uploading ? '上传中' : '上传'}
          </button>
        </div>
      </div>

      {/* 无限层级目录树 */}
      <div
        className="flex-1 overflow-y-auto py-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={async () => {
          if (!dragId) return;
          await api.moveNode(dragId, { newParentId: null });
          setDragId(null);
          await loadTree();
        }}
      >
        {tree.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400">
            还没有任何笔记，点击上方「笔记」或「上传」开始构建你的目录树
          </div>
        ) : (
          tree.map((node) => renderItem(node, 0))
        )}
      </div>

      {/* 底部工具栏 */}
      <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
        <button
          type="button"
          onClick={() => setMigrationOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 font-medium text-blue-700 dark:text-blue-400"
        >
          <Download className="w-3.5 h-3.5" />
          OneNote 导入
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800"
            title="切换浅色/深色主题"
          >
            {theme === 'light' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setUser(null, null)}
            className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800"
            title="退出登录"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Edit3,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderPlus,
  LogOut,
  Moon,
  Pin,
  Plus,
  Search,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import type { NodeTreeItem, NodeType } from '@yunshu/shared';
import { api, sha256File } from '../lib/api';
import { markdownToHtml } from '../lib/markdown';
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

interface ContextMenuState {
  x: number;
  y: number;
  node: NodeTreeItem | null; // null 表示空白区根目录右键菜单
}

const NODE_DRAG_MIME = 'application/x-yunshu-node-id';

export const SidebarTree: React.FC<{ touchFriendly?: boolean }> = ({ touchFriendly = false }) => {
  const nodes = useAppStore((s) => s.nodes);
  const tree = useAppStore((s) => s.tree);
  const activeNodeId = useAppStore((s) => s.activeNodeId);
  const expandedIds = useAppStore((s) => s.expandedIds);
  const theme = useAppStore((s) => s.theme);
  const selectNode = useAppStore((s) => s.selectNode);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const setAllExpanded = useAppStore((s) => s.setAllExpanded);
  const loadTree = useAppStore((s) => s.loadTree);
  const setTheme = useAppStore((s) => s.setTheme);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const setUser = useAppStore((s) => s.setUser);

  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<'move' | 'upload' | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);

  // 智能目标目录：选中目录时在该目录下创建/上传；选中文档时在其所属目录下创建/上传
  const activeCreateTarget = useMemo(() => {
    const active = nodes.find((n) => n.id === activeNodeId);
    if (!active) return { id: null as string | null, label: '根目录' };
    if (active.nodeType === 'folder') {
      return { id: active.id, label: active.title };
    }
    if (active.parentId) {
      const parent = nodes.find((n) => n.id === active.parentId);
      if (parent) return { id: parent.id, label: parent.title };
    }
    return { id: null as string | null, label: '根目录' };
  }, [nodes, activeNodeId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const handleCreate = async (nodeType: NodeType, explicitParentId?: string | null) => {
    const parentId = explicitParentId !== undefined ? explicitParentId : activeCreateTarget.id;
    const defaultTitle =
      nodeType === 'folder' ? '新建目录' : nodeType === 'markdown' ? '未命名 Markdown' : '未命名笔记';
    const res = await api.createNode({ parentId, title: defaultTitle, nodeType });
    await loadTree();
    if (parentId && !expandedIds[parentId]) toggleExpand(parentId);
    selectNode(res.node.id);
  };

  const uploadFilesToParent = async (files: FileList | File[], parentId: string | null) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        const lower = file.name.toLowerCase();

        // Markdown 文件支持含表格的双向解析后直接导入为原生节点
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
          const text = await file.text();
          const html = markdownToHtml(text);
          const created = await api.createNode({
            parentId,
            title: file.name.replace(/\.(md|markdown)$/i, ''),
            nodeType: 'markdown',
            contentHtml: html,
            plainText: text,
          });
          await loadTree();
          if (parentId && !expandedIds[parentId]) toggleExpand(parentId);
          selectNode(created.node.id);
          continue;
        }

        const nodeType: NodeType =
          lower.endsWith('.xlsx') || lower.endsWith('.xls')
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
          deviceName: '桌面/Web 端',
        });

        await loadTree();
        if (parentId && !expandedIds[parentId]) toggleExpand(parentId);
        selectNode(created.node.id);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '上传文件失败');
    } finally {
      setUploading(false);
    }
  };

  const triggerUpload = (explicitParentId?: string | null) => {
    uploadParentRef.current = explicitParentId !== undefined ? explicitParentId : activeCreateTarget.id;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFilesToParent(e.target.files, uploadParentRef.current);
    }
    e.target.value = '';
  };

  const handleRename = async (item: NodeTreeItem) => {
    const nextTitle = window.prompt('请输入新的名称：', item.title);
    if (!nextTitle || !nextTitle.trim() || nextTitle.trim() === item.title) return;
    await api.updateNode(item.id, { title: nextTitle.trim() });
    await loadTree();
  };

  const handleTogglePin = async (item: NodeTreeItem) => {
    await api.updateNode(item.id, { isPinned: !item.isPinned });
    await loadTree();
  };

  const handleMoveToRoot = async (itemId: string) => {
    await api.moveNode(itemId, { newParentId: null });
    await loadTree();
  };

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`确定将「${title}」及其子项移入回收站吗？`)) return;
    await api.deleteNode(id);
    if (activeNodeId === id) selectNode(null);
    await loadTree();
  };

  const handleLogout = () => {
    if (!window.confirm('确定要退出当前账号吗？')) return;
    setUser(null, null);
  };

  const isExternalFileDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleDropOnNode = async (e: React.DragEvent, targetItem: NodeTreeItem) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetId(null);
    setDropMode(null);

    // 1. 外部文件拖拽上传：拖到哪个子目录就上传到哪个子目录（拖到普通文档则上传到其所在目录）
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const uploadTargetId = targetItem.nodeType === 'folder' ? targetItem.id : targetItem.parentId;
      await uploadFilesToParent(e.dataTransfer.files, uploadTargetId);
      return;
    }

    // 2. 内部节点拖拽修改上级目录（支持笔记、Markdown、Word、Excel、目录）
    const sourceId = e.dataTransfer.getData(NODE_DRAG_MIME) || dragNodeId;
    setDragNodeId(null);
    if (!sourceId || sourceId === targetItem.id) return;

    try {
      await api.moveNode(sourceId, { newParentId: targetItem.id });
      if (!expandedIds[targetItem.id]) toggleExpand(targetItem.id);
      await loadTree();
    } catch (err) {
      alert(err instanceof Error ? err.message : '移动节点失败');
    }
  };

  const handleDropOnRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRootDropActive(false);
    setDropTargetId(null);
    setDropMode(null);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFilesToParent(e.dataTransfer.files, null);
      return;
    }

    const sourceId = e.dataTransfer.getData(NODE_DRAG_MIME) || dragNodeId;
    setDragNodeId(null);
    if (!sourceId) return;
    try {
      await api.moveNode(sourceId, { newParentId: null });
      await loadTree();
    } catch (err) {
      alert(err instanceof Error ? err.message : '移至根目录失败');
    }
  };

  const openContextMenu = (e: React.MouseEvent, node: NodeTreeItem | null) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 188;
    const menuHeight = node ? 250 : 185;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x: Math.max(8, x), y: Math.max(8, y), node });
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
          onDragStart={(e) => {
            setDragNodeId(item.id);
            e.dataTransfer.setData(NODE_DRAG_MIME, item.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            setDragNodeId(null);
            setDropTargetId(null);
            setDropMode(null);
            setRootDropActive(false);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const isFile = isExternalFileDrag(e);
            e.dataTransfer.dropEffect = isFile ? 'copy' : 'move';
            setDropTargetId(item.id);
            setDropMode(isFile ? 'upload' : 'move');
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (dropTargetId === item.id) {
              setDropTargetId(null);
              setDropMode(null);
            }
          }}
          onDrop={(e) => void handleDropOnNode(e, item)}
          onContextMenu={(e) => openContextMenu(e, item)}
          onClick={() => selectNode(item.id)}
          style={{ paddingLeft: `${depth * 16 + 10}px` }}
          className={`group flex items-center gap-1.5 ${
            touchFriendly ? 'py-2.5 text-sm' : 'py-1.5 text-[13.5px]'
          } pr-2 cursor-pointer rounded-md mx-1.5 select-none transition-colors ${
            isActive
              ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 font-semibold'
              : 'hover:bg-slate-200/60 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
          } ${
            isDropTarget
              ? dropMode === 'upload'
                ? 'ring-2 ring-emerald-500 bg-emerald-50 dark:bg-emerald-950/50'
                : 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/50'
              : ''
          }`}
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
          {item.isPinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}

          <div
            className={`${
              touchFriendly && isActive ? 'flex' : 'hidden group-hover:flex'
            } items-center gap-0.5 shrink-0`}
          >
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
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete(item.id, item.title);
              }}
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
    <aside className="w-full h-full flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.docx,.doc,.xlsx,.xls,.pdf"
        onChange={handleFileSelected}
        className="hidden"
      />

      {/* 顶部搜索与新建操作区 */}
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
            onClick={() => void handleCreate('note')}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white"
            title={`在「${activeCreateTarget.label}」下新建笔记`}
          >
            <Plus className="w-3.5 h-3.5" />
            笔记
          </button>
          <button
            type="button"
            onClick={() => void handleCreate('folder')}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100"
            title={`在「${activeCreateTarget.label}」下新建子目录`}
          >
            <FolderPlus className="w-3.5 h-3.5" />
            目录
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => triggerUpload()}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 disabled:opacity-50"
            title={`上传文档到「${activeCreateTarget.label}」`}
          >
            <Upload className="w-3.5 h-3.5" />
            {uploading ? '上传中' : '上传'}
          </button>
        </div>

        {/* 显示当前新建/上传的目标位置 */}
        <div className="flex items-center justify-between text-[11px] text-slate-500 px-0.5">
          <span className="truncate">
            新建位置：<strong className="text-slate-700 dark:text-slate-300">{activeCreateTarget.label}</strong>
          </span>
          {activeCreateTarget.id && (
            <button
              type="button"
              onClick={() => selectNode(null)}
              className="text-blue-600 hover:underline shrink-0 ml-1"
            >
              回到根目录
            </button>
          )}
        </div>
      </div>

      {/* 拖拽节点时显示「移至根目录」快捷接收区 */}
      {dragNodeId && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setRootDropActive(true);
          }}
          onDragLeave={() => setRootDropActive(false)}
          onDrop={(e) => void handleDropOnRoot(e)}
          className={`mx-2 mt-2 py-1.5 px-2 text-center text-xs rounded-md border border-dashed transition-colors ${
            rootDropActive
              ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
              : 'border-slate-300 text-slate-500 dark:border-slate-700'
          }`}
        >
          拖到此处移至根目录
        </div>
      )}

      {/* 无限层级目录树（支持右键菜单、外部文件拖入上传、内部节点拖拽换父级） */}
      <div
        className={`flex-1 overflow-y-auto py-2 ${
          rootDropActive && !dragNodeId ? 'bg-emerald-50/50 dark:bg-emerald-950/20' : ''
        }`}
        onContextMenu={(e) => openContextMenu(e, null)}
        onDragOver={(e) => {
          e.preventDefault();
          if (isExternalFileDrag(e)) {
            e.dataTransfer.dropEffect = 'copy';
            setRootDropActive(true);
          }
        }}
        onDragLeave={() => setRootDropActive(false)}
        onDrop={(e) => void handleDropOnRoot(e)}
      >
        {tree.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400 leading-relaxed">
            还没有任何笔记或文档
            <br />
            点击上方按钮，或直接把文件拖入此处上传
          </div>
        ) : (
          tree.map((node) => renderItem(node, 0))
        )}
      </div>

      {/* 底部工具栏（已移除 OneNote 导入入口，退出登录增加确认） */}
      <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
        <span className="text-[11px] text-slate-400">右键目录可管理 · 支持拖入上传</span>

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
            onClick={handleLogout}
            className="p-1.5 rounded hover:bg-red-50 hover:text-red-600 dark:hover:bg-slate-800"
            title="退出登录"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* PC 端右键上下文菜单 */}
      {contextMenu && (
        <div
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-48 py-1 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-200"
        >
          {contextMenu.node ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleCreate('note', n.id);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Plus className="w-3.5 h-3.5 text-blue-600" />
                新建子笔记
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleCreate('folder', n.id);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <FolderPlus className="w-3.5 h-3.5 text-slate-500" />
                新建子目录
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  triggerUpload(n.id);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-600" />
                上传文档到此目录
              </button>
              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleRename(n);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Edit3 className="w-3.5 h-3.5" />
                重命名
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleTogglePin(n);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Pin className="w-3.5 h-3.5 text-amber-500" />
                {contextMenu.node.isPinned ? '取消置顶' : '置顶节点'}
              </button>
              {contextMenu.node.parentId && (
                <button
                  type="button"
                  onClick={() => {
                    const n = contextMenu.node!;
                    setContextMenu(null);
                    void handleMoveToRoot(n.id);
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <CornerLeftUp className="w-3.5 h-3.5" />
                  移至根目录
                </button>
              )}
              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleDelete(n.id, n.title);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                移至回收站
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void handleCreate('note', null);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Plus className="w-3.5 h-3.5 text-blue-600" />
                新建顶级笔记
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  void handleCreate('folder', null);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <FolderPlus className="w-3.5 h-3.5 text-slate-500" />
                新建顶级目录
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  triggerUpload(null);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-600" />
                上传文档到根目录
              </button>
              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  setAllExpanded(true);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                全部展开目录
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  setAllExpanded(false);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                全部折叠目录
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
};

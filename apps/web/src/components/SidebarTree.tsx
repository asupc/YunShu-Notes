import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Edit3,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
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
import type { NodeMeta, NodeTreeItem, NodeType } from '@yunshu/shared';
import { api, sha256File } from '../lib/api';
import { markdownToHtml } from '../lib/markdown';
import { useAppStore } from '../store/useAppStore';
import { ConfirmDialog, MoveNodeDialog, RenameDialog, type MoveFolderOption } from './AppDialog';

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
  node: NodeTreeItem | null;
}

interface PointerDragState {
  sourceNode: NodeMeta;
  x: number;
  y: number;
  /** 目标目录 ID；null 表示根目录；undefined 表示尚未悬停在有效投放区 */
  targetParentId: string | null | undefined;
  /** 高亮显示的节点 ID（悬停目录或其父目录） */
  highlightNodeId: string | null;
  /** 是否悬停在根目录投放区 */
  highlightRoot: boolean;
  /** 投放提示与合法性 */
  targetLabel: string;
  status: 'valid' | 'same' | 'invalid' | 'idle';
}

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

  // 内部节点拖拽（基于 Pointer Events，兼容 Windows WebView2 / 浏览器 / 安卓触控）
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  // 外部系统文件拖入上传状态（基于 HTML5 Drag & Drop）
  const [fileDropNodeId, setFileDropNodeId] = useState<string | null>(null);
  const [fileDropRoot, setFileDropRoot] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // 美化弹窗状态：重命名、移动到目录、删除确认、退出登录确认
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<NodeMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const justDraggedRef = useRef(false);
  const autoExpandTimerRef = useRef<{ folderId: string; timer: number } | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

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

  const moveFolderOptions = useMemo<MoveFolderOption[]>(() => {
    const opts: MoveFolderOption[] = [{ id: null, title: '根目录', depth: 0 }];
    if (!moveTarget) return opts;
    const walk = (items: NodeTreeItem[], depth: number) => {
      for (const it of items) {
        if (it.nodeType !== 'folder') continue;
        // 禁止选择自身或自身子目录
        if (it.id === moveTarget.id || it.path.startsWith(moveTarget.path)) continue;
        opts.push({ id: it.id, title: it.title, depth });
        if (it.children.length > 0) walk(it.children, depth + 1);
      }
    };
    walk(tree, 1);
    return opts;
  }, [tree, moveTarget]);

  // 防止拖入外部文件时浏览器直接打开文件导致离开应用
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // F2 快捷键重命名当前选中的目录或笔记
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const el = document.activeElement as HTMLElement | null;
      const inInput =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          Boolean(el.closest('.ProseMirror')));
      if (inInput) return;

      const active = useAppStore.getState().nodes.find((n) => n.id === useAppStore.getState().activeNodeId);
      if (!active) return;
      e.preventDefault();
      setRenameTarget({ id: active.id, title: active.title });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const executeMoveNode = useCallback(
    async (sourceNode: NodeMeta, newParentId: string | null) => {
      if (sourceNode.parentId === newParentId) return;
      const allNodes = useAppStore.getState().nodes;
      const targetFolder = newParentId ? allNodes.find((n) => n.id === newParentId) : null;
      if (targetFolder && (targetFolder.id === sourceNode.id || targetFolder.path.startsWith(sourceNode.path))) {
        showToast('不能将目录移动到自身或子目录下');
        return;
      }
      try {
        await api.moveNode(sourceNode.id, { newParentId });
        if (newParentId && !useAppStore.getState().expandedIds[newParentId]) {
          toggleExpand(newParentId);
        }
        await loadTree();
        const targetName = targetFolder ? targetFolder.title : '根目录';
        showToast(`已将「${sourceNode.title}」移动到「${targetName}」`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '移动节点失败');
      }
    },
    [loadTree, showToast, toggleExpand]
  );

  // 根据指针坐标解析当前悬停的投放目标（零闪烁、兼容 WebView2 / 触控）
  const evaluateDropTarget = useCallback((sourceNode: NodeMeta, clientX: number, clientY: number): Omit<PointerDragState, 'sourceNode' | 'x' | 'y'> => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!el) {
      return { targetParentId: undefined, highlightNodeId: null, highlightRoot: false, targetLabel: '拖到目标目录松开', status: 'idle' };
    }

    const allNodes = useAppStore.getState().nodes;

    // 1. 悬停在顶部「移至根目录」浮层
    if (el.closest('[data-drop-root="true"]')) {
      if (sourceNode.parentId === null) {
        return { targetParentId: null, highlightNodeId: null, highlightRoot: true, targetLabel: '已在根目录', status: 'same' };
      }
      return { targetParentId: null, highlightNodeId: null, highlightRoot: true, targetLabel: '移至「根目录」', status: 'valid' };
    }

    // 2. 悬停在某个目录树节点行上
    const nodeRow = el.closest('[data-drop-node-id]') as HTMLElement | null;
    if (nodeRow) {
      const hoveredId = nodeRow.dataset.dropNodeId;
      const hoveredNode = hoveredId ? allNodes.find((n) => n.id === hoveredId) : undefined;
      if (hoveredNode) {
        // 拖到目录上 -> 移入该目录；拖到文档/笔记上 -> 移入该文档/笔记所在的目录
        const destParentId = hoveredNode.nodeType === 'folder' ? hoveredNode.id : hoveredNode.parentId;
        const destFolder = destParentId ? allNodes.find((n) => n.id === destParentId) : null;

        if (destFolder && (destFolder.id === sourceNode.id || destFolder.path.startsWith(sourceNode.path))) {
          return {
            targetParentId: destParentId,
            highlightNodeId: destFolder.id,
            highlightRoot: false,
            targetLabel: '不能移动到自身或子目录',
            status: 'invalid',
          };
        }

        if (destParentId === sourceNode.parentId) {
          return {
            targetParentId: destParentId,
            highlightNodeId: destFolder ? destFolder.id : null,
            highlightRoot: destParentId === null,
            targetLabel: destFolder ? `已在「${destFolder.title}」中` : '已在根目录',
            status: 'same',
          };
        }

        return {
          targetParentId: destParentId,
          highlightNodeId: destFolder ? destFolder.id : null,
          highlightRoot: destParentId === null,
          targetLabel: destFolder ? `移动到「${destFolder.title}」` : '移至「根目录」',
          status: 'valid',
        };
      }
    }

    // 3. 悬停在目录树空白区域 -> 移至根目录
    if (el.closest('[data-drop-tree-area="true"]')) {
      if (sourceNode.parentId === null) {
        return { targetParentId: null, highlightNodeId: null, highlightRoot: true, targetLabel: '已在根目录', status: 'same' };
      }
      return { targetParentId: null, highlightNodeId: null, highlightRoot: true, targetLabel: '移至「根目录」', status: 'valid' };
    }

    return { targetParentId: undefined, highlightNodeId: null, highlightRoot: false, targetLabel: '拖到左侧目录松开', status: 'idle' };
  }, []);

  const clearAutoExpandTimer = () => {
    if (autoExpandTimerRef.current) {
      window.clearTimeout(autoExpandTimerRef.current.timer);
      autoExpandTimerRef.current = null;
    }
  };

  // 启动内部节点指针拖拽（PC 鼠标移动 6px 即触发；触控长按 350ms 触发，不干扰列表滚动）
  const startNodePointerDrag = (e: React.PointerEvent, item: NodeTreeItem) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const isTouch = e.pointerType === 'touch';
    let active = false;
    let latestState: PointerDragState | null = null;
    let longPressTimer: number | null = null;

    const activateDrag = (x: number, y: number) => {
      if (active) return;
      active = true;
      document.body.style.userSelect = 'none';
      const evalRes = evaluateDropTarget(item, x, y);
      latestState = { sourceNode: item, x, y, ...evalRes };
      setPointerDrag(latestState);
    };

    if (isTouch) {
      longPressTimer = window.setTimeout(() => {
        activateDrag(startX, startY);
      }, 350);
    }

    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dist = Math.hypot(dx, dy);

      if (!active) {
        if (isTouch) {
          // 触控在长按激活前发生明显滑动 -> 视为正常滚动，取消拖拽
          if (dist > 8 && longPressTimer !== null) {
            window.clearTimeout(longPressTimer);
            longPressTimer = null;
            cleanup();
          }
          return;
        }
        if (dist < 6) return;
        activateDrag(ev.clientX, ev.clientY);
      }

      if (ev.cancelable) ev.preventDefault();

      // 靠近目录树顶部/底部边缘时自动滚动
      const scrollEl = treeScrollRef.current;
      if (scrollEl) {
        const rect = scrollEl.getBoundingClientRect();
        if (ev.clientY < rect.top + 36) {
          scrollEl.scrollTop -= 12;
        } else if (ev.clientY > rect.bottom - 36) {
          scrollEl.scrollTop += 12;
        }
      }

      const evalRes = evaluateDropTarget(item, ev.clientX, ev.clientY);
      latestState = { sourceNode: item, x: ev.clientX, y: ev.clientY, ...evalRes };
      setPointerDrag(latestState);

      // 悬停在折叠目录上 550ms 自动展开，方便直接拖入子目录
      const targetFolderId = evalRes.highlightNodeId;
      if (
        targetFolderId &&
        evalRes.status === 'valid' &&
        !useAppStore.getState().expandedIds[targetFolderId]
      ) {
        if (autoExpandTimerRef.current?.folderId !== targetFolderId) {
          clearAutoExpandTimer();
          autoExpandTimerRef.current = {
            folderId: targetFolderId,
            timer: window.setTimeout(() => {
              if (!useAppStore.getState().expandedIds[targetFolderId]) {
                toggleExpand(targetFolderId);
              }
              autoExpandTimerRef.current = null;
            }, 550),
          };
        }
      } else {
        clearAutoExpandTimer();
      }
    };

    const cleanup = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      clearAutoExpandTimer();
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && active) {
        cleanup();
        setPointerDrag(null);
      }
    };

    const onPointerCancel = () => {
      cleanup();
      setPointerDrag(null);
    };

    const onPointerUp = () => {
      const finalDrag = latestState;
      const wasActive = active;
      cleanup();
      setPointerDrag(null);

      if (wasActive) {
        justDraggedRef.current = true;
        window.setTimeout(() => {
          justDraggedRef.current = false;
        }, 80);

        if (finalDrag && finalDrag.status === 'valid' && finalDrag.targetParentId !== undefined) {
          void executeMoveNode(finalDrag.sourceNode, finalDrag.targetParentId);
        } else if (finalDrag && finalDrag.status === 'invalid') {
          showToast('不能将目录移动到自身或子目录下');
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
  };

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
      showToast(`已成功上传 ${list.length} 个文件`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '上传文件失败');
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
    if (activeNodeId === deleteTarget.id) selectNode(null);
    setDeleteTarget(null);
    await loadTree();
  };

  const handleTogglePin = async (item: NodeTreeItem) => {
    await api.updateNode(item.id, { isPinned: !item.isPinned });
    await loadTree();
  };

  const handleMoveToRoot = async (item: NodeMeta) => {
    await executeMoveNode(item, null);
  };

  const isExternalFileDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleFileDropOnNode = async (e: React.DragEvent, targetItem: NodeTreeItem) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDropNodeId(null);
    setFileDropRoot(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const uploadTargetId = targetItem.nodeType === 'folder' ? targetItem.id : targetItem.parentId;
      await uploadFilesToParent(e.dataTransfer.files, uploadTargetId);
    }
  };

  const handleFileDropOnRoot = async (e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDropRoot(false);
    setFileDropNodeId(null);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFilesToParent(e.dataTransfer.files, null);
    }
  };

  const openContextMenu = (e: React.MouseEvent, node: NodeTreeItem | null) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 192;
    const menuHeight = node ? 290 : 190;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x: Math.max(8, x), y: Math.max(8, y), node });
  };

  const renderItem = (item: NodeTreeItem, depth: number) => {
    const isExpanded = Boolean(expandedIds[item.id]);
    const isActive = activeNodeId === item.id;
    const isDraggingSource = pointerDrag?.sourceNode.id === item.id;
    const isMoveDropTarget = pointerDrag?.highlightNodeId === item.id;
    const isMoveInvalid = isMoveDropTarget && pointerDrag?.status === 'invalid';
    const isFileDropTarget = fileDropNodeId === item.id;
    const hasChildren = item.children.length > 0;

    return (
      <div key={item.id}>
        <div
          data-drop-node-id={item.id}
          onPointerDown={(e) => startNodePointerDrag(e, item)}
          onDragOver={(e) => {
            if (!isExternalFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            setFileDropRoot(false);
            setFileDropNodeId(item.id);
          }}
          onDragLeave={(e) => {
            if (!isExternalFileDrag(e)) return;
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setFileDropNodeId((cur) => (cur === item.id ? null : cur));
            }
          }}
          onDrop={(e) => void handleFileDropOnNode(e, item)}
          onContextMenu={(e) => openContextMenu(e, item)}
          onClick={() => {
            if (justDraggedRef.current) return;
            selectNode(item.id);
          }}
          style={{ paddingLeft: `${depth * 16 + 10}px` }}
          className={`group relative flex items-center gap-1.5 ${
            touchFriendly ? 'py-2.5 text-sm' : 'py-1.5 text-[13.5px]'
          } pr-2 cursor-pointer rounded-md mx-1.5 select-none transition-colors overflow-hidden ${
            isDraggingSource ? 'opacity-40' : ''
          } ${
            isActive
              ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-200 font-semibold'
              : 'hover:bg-slate-200/60 dark:hover:bg-neutral-900 text-slate-700 dark:text-slate-300'
          } ${
            isFileDropTarget
              ? 'ring-2 ring-emerald-500 bg-emerald-50 dark:bg-emerald-950/50'
              : isMoveInvalid
              ? 'ring-2 ring-red-500 bg-red-50 dark:bg-red-950/50'
              : isMoveDropTarget
              ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/50'
              : ''
          }`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(item.id);
            }}
            className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-700 shrink-0"
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
          <span className="truncate flex-1 min-w-0">{item.title}</span>
          {item.isPinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}


        </div>

        {isExpanded && item.children.length > 0 && (
          <div>{item.children.map((child) => renderItem(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-full h-full flex flex-col border-r border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-black">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.docx,.doc,.xlsx,.xls,.pdf"
        onChange={handleFileSelected}
        className="hidden"
      />

      {/* 顶部搜索与新建操作区 */}
      <div className="p-3 space-y-2 border-b border-slate-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs text-slate-500 bg-white dark:bg-neutral-900 border border-slate-200 dark:border-neutral-800 rounded-md hover:border-blue-400"
        >
          <span className="flex items-center gap-1.5">
            <Search className="w-3.5 h-3.5" />
            全局搜索笔记与文档...
          </span>
          <kbd className="px-1 py-0.5 text-[10px] bg-slate-100 dark:bg-neutral-800 rounded">Ctrl+K</kbd>
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
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-neutral-900 border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-800"
            title={`在「${activeCreateTarget.label}」下新建子目录`}
          >
            <FolderPlus className="w-3.5 h-3.5" />
            目录
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => triggerUpload()}
            className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-neutral-900 border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={`上传文档到「${activeCreateTarget.label}」`}
          >
            <Upload className="w-3.5 h-3.5" />
            {uploading ? '上传中' : '上传'}
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-500 px-0.5">
          <span className="truncate">
            新建位置：<strong className="text-slate-700 dark:text-slate-300">{activeCreateTarget.label}</strong>
          </span>
          {activeCreateTarget.id && (
            <button
              type="button"
              onClick={() => selectNode(null)}
              className="text-blue-600 dark:text-blue-400 hover:underline shrink-0 ml-1"
            >
              回到根目录
            </button>
          )}
        </div>
      </div>

      {toastMsg && (
        <div className="mx-2 mt-2 px-2.5 py-1.5 text-xs rounded-md bg-blue-50 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
          {toastMsg}
        </div>
      )}

      {/* 无限层级目录树容器（relative 包裹，顶部根目录投放区采用浮层避免触发任何布局抖动） */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        {pointerDrag && (
          <div
            data-drop-root="true"
            className={`absolute inset-x-2 top-1.5 z-20 py-1.5 px-2 text-center text-xs font-medium rounded-md border border-dashed shadow-sm transition-colors ${
              pointerDrag.highlightRoot
                ? 'border-blue-500 bg-blue-50/95 text-blue-700 dark:bg-blue-950/90 dark:text-blue-300'
                : 'border-slate-300 bg-white/90 text-slate-600 dark:border-neutral-700 dark:bg-neutral-950/90 dark:text-slate-300'
            }`}
          >
            拖到此处移至根目录
          </div>
        )}

        <div
          ref={treeScrollRef}
          data-drop-tree-area="true"
          className={`flex-1 overflow-y-auto overflow-x-hidden py-2 tree-scroll ${
            fileDropRoot
              ? 'bg-emerald-50/50 dark:bg-emerald-950/20'
              : pointerDrag?.highlightRoot && !pointerDrag.highlightNodeId
              ? 'bg-blue-50/30 dark:bg-blue-950/20'
              : ''
          }`}
          onContextMenu={(e) => openContextMenu(e, null)}
          onDragOver={(e) => {
            if (!isExternalFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setFileDropRoot(true);
          }}
          onDragLeave={(e) => {
            if (!isExternalFileDrag(e)) return;
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setFileDropRoot(false);
            }
          }}
          onDrop={(e) => void handleFileDropOnRoot(e)}
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
      </div>

      {/* 底部工具栏 */}
      <div className="p-2.5 border-t border-slate-200 dark:border-neutral-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
        <span className="text-[11px] text-slate-400">拖拽改目录 · F2 重命名</span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-neutral-900"
            title="切换浅色/深色主题"
          >
            {theme === 'light' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setLogoutConfirmOpen(true)}
            className="p-1.5 rounded hover:bg-red-50 hover:text-red-600 dark:hover:bg-neutral-900"
            title="退出登录"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 跟随光标的拖拽预览浮标 */}
      {pointerDrag && (
        <div
          style={{
            left: `${Math.min(pointerDrag.x + 14, window.innerWidth - 220)}px`,
            top: `${Math.min(pointerDrag.y + 14, window.innerHeight - 64)}px`,
          }}
          className={`fixed z-50 pointer-events-none max-w-[220px] px-2.5 py-1.5 rounded-lg shadow-xl border text-xs backdrop-blur-sm ${
            pointerDrag.status === 'invalid'
              ? 'bg-red-50/95 dark:bg-red-950/95 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300'
              : pointerDrag.status === 'valid'
              ? 'bg-blue-50/95 dark:bg-blue-950/95 border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-200'
              : 'bg-white/95 dark:bg-neutral-900/95 border-slate-200 dark:border-neutral-700 text-slate-700 dark:text-slate-200'
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium truncate">
            <NodeIcon type={pointerDrag.sourceNode.nodeType} />
            <span className="truncate">{pointerDrag.sourceNode.title}</span>
          </div>
          <div className="text-[11px] opacity-80 mt-0.5 truncate">{pointerDrag.targetLabel}</div>
        </div>
      )}

      {/* PC 端右键上下文菜单 */}
      {contextMenu && (
        <div
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-48 py-1 rounded-lg shadow-xl border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-xs text-slate-700 dark:text-slate-200"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-600" />
                上传文档到此目录
              </button>
              <div className="my-1 border-t border-slate-100 dark:border-neutral-800" />
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  setRenameTarget({ id: n.id, title: n.title });
                }}
                className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                <span className="flex items-center gap-2">
                  <Edit3 className="w-3.5 h-3.5" />
                  重命名
                </span>
                <kbd className="text-[10px] text-slate-400">F2</kbd>
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  setMoveTarget(n);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                <FolderInput className="w-3.5 h-3.5 text-blue-500" />
                移动到目录...
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  void handleTogglePin(n);
                }}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
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
                    void handleMoveToRoot(n);
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
                >
                  <CornerLeftUp className="w-3.5 h-3.5" />
                  移至根目录
                </button>
              )}
              <div className="my-1 border-t border-slate-100 dark:border-neutral-800" />
              <button
                type="button"
                onClick={() => {
                  const n = contextMenu.node!;
                  setContextMenu(null);
                  setDeleteTarget({ id: n.id, title: n.title });
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-600" />
                上传文档到根目录
              </button>
              <div className="my-1 border-t border-slate-100 dark:border-neutral-800" />
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  setAllExpanded(true);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                全部展开目录
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  setAllExpanded(false);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-neutral-900"
              >
                全部折叠目录
              </button>
            </>
          )}
        </div>
      )}

      {/* 美化版自定义弹窗 */}
      <RenameDialog
        open={Boolean(renameTarget)}
        initialValue={renameTarget?.title ?? ''}
        title="重命名节点"
        onConfirm={handleConfirmRename}
        onCancel={() => setRenameTarget(null)}
      />

      <MoveNodeDialog
        open={Boolean(moveTarget)}
        nodeTitle={moveTarget?.title ?? ''}
        currentParentId={moveTarget?.parentId ?? null}
        options={moveFolderOptions}
        onConfirm={async (targetParentId) => {
          if (moveTarget) {
            await executeMoveNode(moveTarget, targetParentId);
          }
          setMoveTarget(null);
        }}
        onCancel={() => setMoveTarget(null)}
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

      <ConfirmDialog
        open={logoutConfirmOpen}
        title="退出登录"
        description="确定要退出当前账号吗？未同步的本地编辑内容可能会丢失。"
        confirmText="确认退出"
        danger
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          setUser(null);
        }}
        onCancel={() => setLogoutConfirmOpen(false)}
      />
    </aside>
  );
};

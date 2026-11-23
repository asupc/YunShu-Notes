import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  CheckSquare,
  Code,
  Download,
  Heading1,
  Heading2,
  Image as ImageIcon,
  Italic,
  List,
  PlusSquare,
  Table as TableIcon,
} from 'lucide-react';
import type { NodeMeta } from '@yunshu/shared';
import { api } from '../lib/api';
import {
  createBlockId,
  exportCanvasToMarkdown,
  parseCanvasHtml,
  serializeCanvasBlocks,
  type CanvasBlock,
} from '../lib/canvasFormat';
import { useAppStore } from '../store/useAppStore';
import { CanvasBlockEditor } from './CanvasBlockEditor';

interface Props {
  node: NodeMeta;
}

export const NoteEditor: React.FC<Props> = ({ node }) => {
  const loadTree = useAppStore((s) => s.loadTree);
  const markSyncedNow = useAppStore((s) => s.markSyncedNow);

  const [title, setTitle] = useState(node.title);
  const [blocks, setBlocks] = useState<CanvasBlock[]>([]);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [autoFocusBlockId, setAutoFocusBlockId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'synced' | 'saving'>('synced');
  const [uploadingImg, setUploadingImg] = useState(false);
  const [, setToolbarTick] = useState(0);

  const saveTimerRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const editorsRef = useRef<Map<string, Editor>>(new Map());
  const latestBlocksRef = useRef<CanvasBlock[]>([]);
  const latestTitleRef = useRef(node.title);

  latestBlocksRef.current = blocks;
  latestTitleRef.current = title;

  const persistBlocks = useCallback(
    async (targetNodeId: string, blocksToSave: CanvasBlock[], includeTitle?: string) => {
      const { contentHtml, plainText } = serializeCanvasBlocks(blocksToSave);
      await api.updateNode(targetNodeId, {
        ...(includeTitle ? { title: includeTitle } : {}),
        contentHtml,
        plainText,
      });
      setSaveState('synced');
      markSyncedNow();
    },
    [markSyncedNow]
  );

  const scheduleSave = useCallback(
    (nextBlocks: CanvasBlock[], immediate = false) => {
      latestBlocksRef.current = nextBlocks;
      setSaveState('saving');
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (immediate) {
        void persistBlocks(node.id, nextBlocks);
      } else {
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void persistBlocks(node.id, latestBlocksRef.current);
        }, 800);
      }
    },
    [node.id, persistBlocks]
  );

  // 加载笔记内容并自动还原为自由画布文本块
  useEffect(() => {
    setTitle(node.title);
    setLoadedNodeId(null);
    setAutoFocusBlockId(null);
    editorsRef.current.clear();

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    let cancelled = false;
    void (async () => {
      const detail = await api.getNode(node.id);
      if (cancelled) return;
      const viewportW = canvasScrollRef.current?.clientWidth || 860;
      const defaultBlockW = Math.max(300, Math.min(820, viewportW - 64));
      const parsed = parseCanvasHtml(detail.contentHtml || '', defaultBlockW);
      setBlocks(parsed);
      latestBlocksRef.current = parsed;
      setActiveBlockId(parsed[0]?.id ?? null);
      setLoadedNodeId(node.id);
      setSaveState('synced');
    })();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [node.id]);

  // 响应顶栏「手动同步」按钮
  useEffect(() => {
    const onManualSync = async () => {
      if (loadedNodeId !== node.id) return;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setSaveState('saving');
      await persistBlocks(
        node.id,
        latestBlocksRef.current,
        latestTitleRef.current.trim() || node.title
      );
    };
    window.addEventListener('yunshu:manual-sync', onManualSync);
    return () => window.removeEventListener('yunshu:manual-sync', onManualSync);
  }, [loadedNodeId, node.id, node.title, persistBlocks]);

  const handleRegisterEditor = useCallback((blockId: string, ed: Editor | null) => {
    if (ed) {
      editorsRef.current.set(blockId, ed);
    } else {
      editorsRef.current.delete(blockId);
    }
  }, []);

  const handleFocusBlock = useCallback((blockId: string, ed: Editor) => {
    editorsRef.current.set(blockId, ed);
    setActiveBlockId(blockId);
    setToolbarTick((t) => t + 1);
    setBlocks((prev) => {
      const maxZ = prev.reduce((m, b) => Math.max(m, b.zIndex), 1);
      const target = prev.find((b) => b.id === blockId);
      if (!target || target.zIndex === maxZ) return prev;
      return prev.map((b) => (b.id === blockId ? { ...b, zIndex: maxZ + 1 } : b));
    });
  }, []);

  const handleContentChange = useCallback(
    (blockId: string, html: string) => {
      setBlocks((prev) => {
        const next = prev.map((b) => (b.id === blockId ? { ...b, html } : b));
        scheduleSave(next, false);
        return next;
      });
      setToolbarTick((t) => t + 1);
    },
    [scheduleSave]
  );

  const handleGeometryChange = useCallback(
    (
      blockId: string,
      patch: Partial<Pick<CanvasBlock, 'x' | 'y' | 'width' | 'minHeight'>>,
      commit = false
    ) => {
      setBlocks((prev) => {
        const next = prev.map((b) => (b.id === blockId ? { ...b, ...patch } : b));
        if (commit) {
          scheduleSave(next, true);
        } else {
          latestBlocksRef.current = next;
        }
        return next;
      });
    },
    [scheduleSave]
  );

  const handleDeleteBlock = useCallback(
    (blockId: string) => {
      setBlocks((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((b) => b.id !== blockId);
        if (activeBlockId === blockId) {
          setActiveBlockId(next[0]?.id ?? null);
        }
        scheduleSave(next, true);
        return next;
      });
    },
    [activeBlockId, scheduleSave]
  );

  const addBlockAt = useCallback(
    (x: number, y: number, initialHtml = '') => {
      const viewportW = canvasScrollRef.current?.clientWidth || 800;
      const defaultW = Math.min(420, Math.max(240, viewportW - 48));
      const newId = createBlockId();
      setBlocks((prev) => {
        const maxZ = prev.reduce((m, b) => Math.max(m, b.zIndex), 1);
        const next: CanvasBlock[] = [
          ...prev,
          {
            id: newId,
            x: Math.max(0, Math.round(x)),
            y: Math.max(0, Math.round(y)),
            width: defaultW,
            minHeight: 0,
            zIndex: maxZ + 1,
            html: initialHtml,
          },
        ];
        scheduleSave(next, true);
        return next;
      });
      setActiveBlockId(newId);
      setAutoFocusBlockId(newId);
      return newId;
    },
    [scheduleSave]
  );

  const handleToolbarAddBlock = () => {
    const cur = latestBlocksRef.current;
    if (cur.length === 0) {
      addBlockAt(0, 0);
      return;
    }
    const refBlock = cur.find((b) => b.id === activeBlockId) || cur[cur.length - 1];
    const viewportW = canvasScrollRef.current?.clientWidth || 960;
    const candidateRightX = refBlock.x + refBlock.width + 24;
    if (candidateRightX + 320 <= viewportW) {
      addBlockAt(candidateRightX, refBlock.y);
    } else {
      const maxY = cur.reduce((m, b) => Math.max(m, b.y + Math.max(b.minHeight, 140)), 0);
      addBlockAt(refBlock.x, maxY + 24);
    }
  };

  const getActiveEditor = (): Editor | null => {
    if (activeBlockId) {
      const ed = editorsRef.current.get(activeBlockId);
      if (ed) return ed;
    }
    const firstId = blocks[0]?.id;
    return firstId ? editorsRef.current.get(firstId) ?? null : null;
  };

  const uploadAndInsertImage = useCallback(async (file: File, targetEditor: Editor) => {
    if (!file.type.startsWith('image/')) return;
    setUploadingImg(true);
    try {
      const { url } = await api.uploadImage(file);
      targetEditor.chain().focus().setImage({ src: url, alt: file.name || '图片' }).run();
    } catch (err) {
      console.error('图片上传失败:', err);
    } finally {
      setUploadingImg(false);
    }
  }, []);

  const handleTitleBlur = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === node.title) return;
    await api.updateNode(node.id, { title: trimmed });
    await loadTree();
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const targetEditor = getActiveEditor();
    if (files && files.length > 0 && targetEditor) {
      for (const f of Array.from(files)) {
        await uploadAndInsertImage(f, targetEditor);
      }
    }
    e.target.value = '';
  };

  const handleExportMarkdown = () => {
    const text = exportCanvasToMarkdown(title || node.title, latestBlocksRef.current);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || node.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-canvas-box="1"]')) return;
    const stage = canvasStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left - 16);
    const y = Math.max(0, e.clientY - rect.top - 12);
    addBlockAt(x, y);
  };

  const handleCanvasSingleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-canvas-box="1"]')) return;
    // 只有单个文本块时，单击空白处直接聚焦该文本块，保持普通文档一样顺手
    if (blocks.length === 1) {
      const onlyEd = editorsRef.current.get(blocks[0].id);
      onlyEd?.commands.focus('end');
    }
  };

  const handleCanvasDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-canvas-box="1"]')) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    e.preventDefault();
    e.stopPropagation();

    const stage = canvasStageRef.current;
    const rect = stage?.getBoundingClientRect();
    const x = rect ? Math.max(0, e.clientX - rect.left - 16) : 24;
    const y = rect ? Math.max(0, e.clientY - rect.top - 12) : 24;

    setUploadingImg(true);
    try {
      const imgTags: string[] = [];
      for (const img of images) {
        const { url } = await api.uploadImage(img);
        imgTags.push(`<img src="${url}" alt="${img.name || '图片'}" />`);
      }
      addBlockAt(x, y, imgTags.join(''));
    } catch (err) {
      console.error('画布拖入图片失败:', err);
    } finally {
      setUploadingImg(false);
    }
  };

  // 自动向右下扩展的画布舞台尺寸
  const stageSize = useMemo(() => {
    const maxRight = blocks.reduce((m, b) => Math.max(m, b.x + b.width), 0);
    const maxBottom = blocks.reduce((m, b) => Math.max(m, b.y + Math.max(b.minHeight, 260)), 0);
    return {
      minWidth: Math.max(640, maxRight + 240),
      minHeight: Math.max(560, maxBottom + 320),
    };
  }, [blocks]);

  const activeEditor = getActiveEditor();
  const inTable = Boolean(activeEditor?.isActive('table'));

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-white dark:bg-black">
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleImagePick}
        className="hidden"
      />

      {/* 顶部格式工具栏（作用于当前激活的画布文本区域） */}
      <div className="px-3 sm:px-5 py-2 border-b border-slate-200 dark:border-neutral-800 flex items-center justify-between gap-2 bg-white dark:bg-black shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={handleToolbarAddBlock}
            className="inline-flex items-center gap-1 px-2 py-1.5 sm:py-1 rounded bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 text-xs font-medium shrink-0 mr-1"
            title="在画布上新增一个独立文本区域（也可直接双击空白处）"
          >
            <PlusSquare className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">文本框</span>
          </button>

          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleHeading({ level: 1 }).run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="一级标题"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleHeading({ level: 2 }).run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="二级标题"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleBold().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="加粗"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleItalic().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="斜体"
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleBulletList().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleTaskList().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="待办清单"
          >
            <CheckSquare className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => getActiveEditor()?.chain().focus().toggleCodeBlock().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="代码块"
          >
            <Code className="w-4 h-4" />
          </button>
          <button
            type="button"
            disabled={uploadingImg}
            onClick={() => imageInputRef.current?.click()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0 disabled:opacity-50"
            title="插入图片（支持拖拽角标调整大小，也可直接粘贴或拖入）"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              getActiveEditor()?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-neutral-900 shrink-0"
            title="插入表格 (3x3)"
          >
            <TableIcon className="w-4 h-4" />
          </button>

          {inTable && (
            <div className="flex items-center gap-1 ml-1 pl-2 border-l border-slate-200 dark:border-neutral-800 text-xs shrink-0">
              <button
                type="button"
                onClick={() => getActiveEditor()?.chain().focus().addRowAfter().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-neutral-900 hover:bg-slate-200 dark:hover:bg-neutral-800"
              >
                +行
              </button>
              <button
                type="button"
                onClick={() => getActiveEditor()?.chain().focus().deleteRow().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-neutral-900 hover:bg-slate-200 dark:hover:bg-neutral-800"
              >
                -行
              </button>
              <button
                type="button"
                onClick={() => getActiveEditor()?.chain().focus().addColumnAfter().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-neutral-900 hover:bg-slate-200 dark:hover:bg-neutral-800"
              >
                +列
              </button>
              <button
                type="button"
                onClick={() => getActiveEditor()?.chain().focus().deleteColumn().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-neutral-900 hover:bg-slate-200 dark:hover:bg-neutral-800"
              >
                -列
              </button>
              <button
                type="button"
                onClick={() => getActiveEditor()?.chain().focus().deleteTable().run()}
                className="px-1.5 py-1 rounded bg-red-50 text-red-600 dark:bg-red-950/50 hover:bg-red-100"
              >
                删表
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 text-xs shrink-0">
          {uploadingImg && <span className="text-blue-600 dark:text-blue-400">图片上传中...</span>}
          <span
            className={`px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
              saveState === 'synced'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-amber-50 text-amber-700'
            }`}
          >
            {saveState === 'synced' ? '● 已同步' : '○ 保存中...'}
          </span>
          <button
            type="button"
            onClick={handleExportMarkdown}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-900 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">导出 MD</span>
          </button>
        </div>
      </div>

      {/* 固定在画布上方的笔记标题区 */}
      <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-2.5 border-b border-slate-100 dark:border-neutral-900 shrink-0 bg-white dark:bg-black flex items-baseline justify-between gap-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="输入笔记标题..."
          className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold bg-transparent outline-none text-slate-900 dark:text-slate-100"
        />
        <span className="hidden md:inline text-[11px] text-slate-400 dark:text-neutral-600 shrink-0 select-none">
          双击空白处新建文本框 · 拖动顶栏移位 · 拖边框改大小
        </span>
      </div>

      {/* 自动无限延伸的类 OneNote 自由画布区 */}
      <div
        ref={canvasScrollRef}
        className="flex-1 w-full overflow-auto bg-white dark:bg-black"
        onClick={handleCanvasSingleClick}
        onDoubleClick={handleCanvasDoubleClick}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => void handleCanvasDrop(e)}
      >
        <div
          ref={canvasStageRef}
          style={{
            minWidth: `${stageSize.minWidth}px`,
            minHeight: `${stageSize.minHeight}px`,
          }}
          className="relative w-full h-full mx-4 sm:mx-6 lg:mx-8 my-4"
        >
          {loadedNodeId === node.id &&
            blocks.map((block) => (
              <CanvasBlockEditor
                key={`${node.id}:${block.id}`}
                block={block}
                isActive={activeBlockId === block.id}
                canDelete={blocks.length > 1}
                autoFocus={autoFocusBlockId === block.id}
                onRegisterEditor={handleRegisterEditor}
                onFocusBlock={handleFocusBlock}
                onContentChange={handleContentChange}
                onGeometryChange={handleGeometryChange}
                onDeleteBlock={handleDeleteBlock}
                onUploadImage={uploadAndInsertImage}
              />
            ))}
        </div>
      </div>
    </div>
  );
};

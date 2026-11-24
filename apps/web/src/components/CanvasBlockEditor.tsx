import React, { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { GripHorizontal, Trash2 } from 'lucide-react';
import type { CanvasBlock } from '../lib/canvasFormat';
import { ResizableImage } from './ResizableImageExtension';

interface CanvasBlockEditorProps {
  block: CanvasBlock;
  isActive: boolean;
  canDelete: boolean;
  autoFocus?: boolean;
  /** 仅在画布级撤销/重做或恢复历史版本时递增，用来同步外部内容而不破坏正常输入时的撤销栈 */
  externalSyncToken: number;
  onRegisterEditor: (blockId: string, editor: Editor | null) => void;
  onFocusBlock: (blockId: string, editor: Editor) => void;
  onContentChange: (blockId: string, html: string, deletedContent: boolean) => void;
  onGeometryChange: (
    blockId: string,
    patch: Partial<Pick<CanvasBlock, 'x' | 'y' | 'width' | 'minHeight'>>,
    commit?: boolean
  ) => void;
  onDeleteBlock: (blockId: string) => void;
  onUploadImage: (file: File, targetEditor: Editor) => Promise<void>;
}

export const CanvasBlockEditor: React.FC<CanvasBlockEditorProps> = ({
  block,
  isActive,
  canDelete,
  autoFocus = false,
  externalSyncToken,
  onRegisterEditor,
  onFocusBlock,
  onContentChange,
  onGeometryChange,
  onDeleteBlock,
  onUploadImage,
}) => {
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const applyingExternalRef = useRef(false);
  const lastHtmlLenRef = useRef((block.html || '').length);
  const appliedSyncTokenRef = useRef(externalSyncToken);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: {
          depth: 200,
          newGroupDelay: 250,
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      ResizableImage.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({
        placeholder: '输入内容，支持 Markdown、表格、Ctrl+V 粘贴图片（双击空白画布可新建文本区域）...',
      }),
    ],
    content: block.html || '',
    editorProps: {
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items || !editor) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              void onUploadImage(file, editor);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0 || !editor) return false;
        const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (images.length === 0) return false;
        event.preventDefault();
        event.stopPropagation();
        for (const imgFile of images) {
          void onUploadImage(imgFile, editor);
        }
        return true;
      },
    },
    onFocus: ({ editor: ed }) => {
      onFocusBlock(block.id, ed);
    },
    onUpdate: ({ editor: ed }) => {
      if (applyingExternalRef.current) return;
      const nextHtml = ed.getHTML();
      const deletedContent = nextHtml.length < lastHtmlLenRef.current;
      lastHtmlLenRef.current = nextHtml.length;
      onContentChange(block.id, nextHtml, deletedContent);
    },
  });

  useEffect(() => {
    onRegisterEditor(block.id, editor);
    return () => onRegisterEditor(block.id, null);
  }, [block.id, editor, onRegisterEditor]);

  // 仅当 externalSyncToken 变化（画布级撤销/重做/恢复历史版本）时同步外部 HTML
  useEffect(() => {
    if (!editor) return;
    if (appliedSyncTokenRef.current === externalSyncToken) return;
    appliedSyncTokenRef.current = externalSyncToken;
    const targetHtml = block.html || '';
    if (editor.getHTML() === targetHtml) return;
    applyingExternalRef.current = true;
    try {
      editor.commands.setContent(targetHtml, false);
      lastHtmlLenRef.current = targetHtml.length;
    } finally {
      applyingExternalRef.current = false;
    }
  }, [editor, externalSyncToken, block.html]);

  useEffect(() => {
    if (autoFocus && editor) {
      window.setTimeout(() => {
        editor.commands.focus('end');
      }, 20);
    }
  }, [autoFocus, editor]);

  // 拖动顶部手柄移动文本框位置
  const startMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    if (editor) onFocusBlock(block.id, editor);

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = block.x;
    const origY = block.y;
    let lastX = origX;
    let lastY = origY;
    setDragging(true);
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      if (ev.cancelable) ev.preventDefault();
      lastX = Math.max(0, Math.round(origX + (ev.clientX - startX)));
      lastY = Math.max(0, Math.round(origY + (ev.clientY - startY)));
      onGeometryChange(block.id, { x: lastX, y: lastY }, false);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      setDragging(false);
      onGeometryChange(block.id, { x: lastX, y: lastY }, true);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // 拖动右边缘 / 底边缘 / 右下角调整文本框尺寸
  const startResize = (e: React.PointerEvent, mode: 'width' | 'height' | 'both') => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (editor) onFocusBlock(block.id, editor);

    const boxEl = (e.currentTarget as HTMLElement).closest('[data-canvas-box="1"]') as HTMLElement | null;
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = block.width;
    const origH = block.minHeight > 0 ? block.minHeight : boxEl?.getBoundingClientRect().height || 120;
    let lastW = origW;
    let lastH = block.minHeight;
    setResizing(true);
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      if (ev.cancelable) ev.preventDefault();
      const patch: Partial<Pick<CanvasBlock, 'width' | 'minHeight'>> = {};
      if (mode === 'width' || mode === 'both') {
        lastW = Math.max(200, Math.min(2400, Math.round(origW + (ev.clientX - startX))));
        patch.width = lastW;
      }
      if (mode === 'height' || mode === 'both') {
        lastH = Math.max(72, Math.min(3000, Math.round(origH + (ev.clientY - startY))));
        patch.minHeight = lastH;
      }
      onGeometryChange(block.id, patch, false);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';
      setResizing(false);
      const patch: Partial<Pick<CanvasBlock, 'width' | 'minHeight'>> = {};
      if (mode === 'width' || mode === 'both') patch.width = lastW;
      if (mode === 'height' || mode === 'both') patch.minHeight = lastH;
      onGeometryChange(block.id, patch, true);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      data-canvas-box="1"
      onClick={(e) => {
        e.stopPropagation();
        if (editor && !editor.isFocused) {
          onFocusBlock(block.id, editor);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        left: `${block.x}px`,
        top: `${block.y}px`,
        width: `${block.width}px`,
        minHeight: block.minHeight > 0 ? `${block.minHeight}px` : undefined,
        zIndex: dragging || resizing ? 40 : block.zIndex,
      }}
      className={`group/box absolute flex flex-col rounded-lg border transition-colors ${
        dragging || resizing
          ? 'border-blue-500 bg-white/95 dark:bg-neutral-950/95 shadow-xl'
          : isActive
          ? 'border-slate-300/90 dark:border-neutral-700 bg-white/80 dark:bg-black/80 shadow-sm'
          : 'border-transparent hover:border-slate-200 dark:hover:border-neutral-800 bg-transparent'
      }`}
    >
      {/* 类 OneNote 顶部拖拽手柄栏 */}
      <div
        onPointerDown={startMove}
        style={{ touchAction: 'none' }}
        title="按住拖动调整位置"
        className={`h-5 px-2 flex items-center justify-between rounded-t-lg cursor-grab active:cursor-grabbing select-none transition-opacity ${
          isActive || dragging || resizing
            ? 'opacity-100 bg-slate-100/90 dark:bg-neutral-900/90 border-b border-slate-200/70 dark:border-neutral-800'
            : 'opacity-0 group-hover/box:opacity-100 bg-slate-100/80 dark:bg-neutral-900/80 border-b border-slate-200/60 dark:border-neutral-800'
        }`}
      >
        <div className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-neutral-500">
          <GripHorizontal className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">拖动移动</span>
        </div>

        <div className="flex items-center gap-1">
          {(dragging || resizing) && (
            <span className="text-[10px] font-mono text-slate-400 dark:text-neutral-500">
              {Math.round(block.width)}px
            </span>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteBlock(block.id);
              }}
              className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/60"
              title="删除此文本区域"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* 富文本编辑内容区 */}
      <div
        className="flex-1 px-3 py-2 cursor-text"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            editor?.commands.focus('end');
          }
        }}
      >
        <EditorContent editor={editor} className="canvas-block-editor w-full" />
      </div>

      {/* 右侧宽度调整手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'width')}
        style={{ touchAction: 'none' }}
        title="拖拽调整宽度"
        className={`absolute top-5 -right-1 bottom-3 w-2 cursor-ew-resize rounded-full transition-colors ${
          resizing ? 'bg-blue-500/60' : 'bg-transparent hover:bg-blue-400/50'
        }`}
      />

      {/* 底部高度调整手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'height')}
        style={{ touchAction: 'none' }}
        title="拖拽调整高度"
        className={`absolute left-3 right-3 -bottom-1 h-2 cursor-ns-resize rounded-full transition-colors ${
          resizing ? 'bg-blue-500/60' : 'bg-transparent hover:bg-blue-400/50'
        }`}
      />

      {/* 右下角自由缩放手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'both')}
        style={{ touchAction: 'none' }}
        title="拖拽调整文本区域大小"
        className={`absolute -right-1 -bottom-1 w-3.5 h-3.5 cursor-nwse-resize flex items-center justify-center transition-opacity ${
          isActive || resizing ? 'opacity-100' : 'opacity-0 group-hover/box:opacity-100'
        }`}
      >
        <span className="w-2 h-2 rounded-br-sm border-r-2 border-b-2 border-slate-400 dark:border-neutral-500 hover:border-blue-500" />
      </div>
    </div>
  );
};

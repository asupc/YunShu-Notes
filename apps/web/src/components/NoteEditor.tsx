import React, { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
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
  Table as TableIcon,
} from 'lucide-react';
import type { NodeMeta } from '@yunshu/shared';
import { api } from '../lib/api';
import { htmlToMarkdown } from '../lib/markdown';
import { useAppStore } from '../store/useAppStore';

interface Props {
  node: NodeMeta;
}

export const NoteEditor: React.FC<Props> = ({ node }) => {
  const loadTree = useAppStore((s) => s.loadTree);
  const markSyncedNow = useAppStore((s) => s.markSyncedNow);
  const [title, setTitle] = useState(node.title);
  const [saveState, setSaveState] = useState<'synced' | 'saving'>('synced');
  const [uploadingImg, setUploadingImg] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const uploadAndInsertImage = async (file: File, targetEditor: ReturnType<typeof useEditor>) => {
    if (!targetEditor || !file.type.startsWith('image/')) return;
    setUploadingImg(true);
    try {
      const { url } = await api.uploadImage(file);
      targetEditor.chain().focus().setImage({ src: url, alt: file.name || '图片' }).run();
    } catch (err) {
      console.error('图片上传失败:', err);
    } finally {
      setUploadingImg(false);
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({
        placeholder: '开始输入笔记内容，支持 Markdown 快捷键、表格、以及直接 Ctrl+V 粘贴或拖入图片...',
      }),
    ],
    editorProps: {
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              void uploadAndInsertImage(file, editor);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (images.length === 0) return false;
        event.preventDefault();
        for (const imgFile of images) {
          void uploadAndInsertImage(imgFile, editor);
        }
        return true;
      },
    },
    content: '',
    onUpdate: ({ editor: ed }) => {
      setSaveState('saving');
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(async () => {
        await api.updateNode(node.id, {
          contentHtml: ed.getHTML(),
          plainText: ed.getText(),
        });
        setSaveState('synced');
        markSyncedNow();
      }, 800);
    },
  });

  useEffect(() => {
    setTitle(node.title);
    let cancelled = false;
    void (async () => {
      const detail = await api.getNode(node.id);
      if (!cancelled && editor) {
        editor.commands.setContent(detail.contentHtml || '', false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id, editor]);

  useEffect(() => {
    const onManualSync = async () => {
      if (!editor) return;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setSaveState('saving');
      await api.updateNode(node.id, {
        title: title.trim() || node.title,
        contentHtml: editor.getHTML(),
        plainText: editor.getText(),
      });
      setSaveState('synced');
      markSyncedNow();
    };
    window.addEventListener('yunshu:manual-sync', onManualSync);
    return () => window.removeEventListener('yunshu:manual-sync', onManualSync);
  }, [editor, node.id, node.title, title, markSyncedNow]);

  const handleTitleBlur = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === node.title) return;
    await api.updateNode(node.id, { title: trimmed });
    await loadTree();
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0 && editor) {
      for (const f of Array.from(files)) {
        await uploadAndInsertImage(f, editor);
      }
    }
    e.target.value = '';
  };

  const handleExportMarkdown = () => {
    if (!editor) return;
    const bodyMd = htmlToMarkdown(editor.getHTML());
    const text = `# ${title}\n\n${bodyMd}\n`;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inTable = Boolean(editor?.isActive('table'));

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-white dark:bg-slate-950">
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleImagePick}
        className="hidden"
      />

      {/* 顶部格式工具栏（含插入图片、表格与行列操作） */}
      <div className="px-3 sm:px-5 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-white dark:bg-slate-950 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="一级标题"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="二级标题"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleBold().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="加粗"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="斜体"
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="待办清单"
          >
            <CheckSquare className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="代码块"
          >
            <Code className="w-4 h-4" />
          </button>
          <button
            type="button"
            disabled={uploadingImg}
            onClick={() => imageInputRef.current?.click()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 disabled:opacity-50"
            title="插入图片（也可直接 Ctrl+V 粘贴或拖入）"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            className="p-2 sm:p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            title="插入表格 (3x3)"
          >
            <TableIcon className="w-4 h-4" />
          </button>

          {inTable && (
            <div className="flex items-center gap-1 ml-1 pl-2 border-l border-slate-200 dark:border-slate-700 text-xs shrink-0">
              <button
                type="button"
                onClick={() => editor?.chain().focus().addRowAfter().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                +行
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().deleteRow().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                -行
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().addColumnAfter().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                +列
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().deleteColumn().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                -列
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().deleteTable().run()}
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
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">导出 MD</span>
          </button>
        </div>
      </div>

      {/* 全宽全高编辑画布 */}
      <div
        className="flex-1 w-full overflow-y-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col cursor-text"
        onClick={(e) => {
          if (e.target === e.currentTarget) editor?.commands.focus('end');
        }}
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="输入笔记标题..."
          className="w-full text-2xl sm:text-3xl font-bold bg-transparent outline-none mb-4 text-slate-900 dark:text-slate-100 shrink-0"
        />
        <div className="flex-1 w-full flex flex-col">
          <EditorContent editor={editor} className="flex-1 w-full flex flex-col" />
        </div>
      </div>
    </div>
  );
};

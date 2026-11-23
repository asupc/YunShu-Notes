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
import {
  Bold,
  CheckSquare,
  Code,
  Download,
  Heading1,
  Heading2,
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
  const saveTimerRef = useRef<number | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder: '开始输入笔记内容，支持 Markdown 快捷键（# 标题、- 列表、``` 代码块）与表格编辑...',
      }),
    ],
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

  // 响应顶栏「手动同步」按钮，立即保存未落盘内容
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
      {/* 顶部格式工具栏（支持表格插入与行列操作） */}
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
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
              >
                +行
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().deleteRow().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
              >
                -行
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().addColumnAfter().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
              >
                +列
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().deleteColumn().run()}
                className="px-1.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200"
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

      {/* 全宽全高编辑画布：占满除导航栏以外的所有剩余区域 */}
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

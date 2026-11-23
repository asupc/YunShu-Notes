import React, { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Bold, CheckSquare, Code, Download, Heading1, Heading2, Italic, List } from 'lucide-react';
import type { NodeMeta } from '@yunshu/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface Props {
  node: NodeMeta;
}

export const NoteEditor: React.FC<Props> = ({ node }) => {
  const loadTree = useAppStore((s) => s.loadTree);
  const [title, setTitle] = useState(node.title);
  const [saveState, setSaveState] = useState<'synced' | 'saving'>('synced');
  const saveTimerRef = useRef<number | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: '开始输入笔记内容，支持 Markdown 快捷键（# 标题、- 列表、``` 代码块）...' }),
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

  const handleTitleBlur = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === node.title) return;
    await api.updateNode(node.id, { title: trimmed });
    await loadTree();
  };

  const handleExportMarkdown = () => {
    if (!editor) return;
    const text = `# ${title}\n\n${editor.getText()}`;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* 顶部格式工具栏 */}
      <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-white dark:bg-slate-950">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="一级标题"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="二级标题"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleBold().run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="加粗"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="斜体"
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="待办清单"
          >
            <CheckSquare className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="代码块"
          >
            <Code className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span
            className={`px-2 py-0.5 rounded-full font-medium ${
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
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" />
            导出 MD
          </button>
        </div>
      </div>

      {/* 编辑画布（最大宽度 780px 居中） */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="max-w-[780px] mx-auto">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            placeholder="输入笔记标题..."
            className="w-full text-3xl font-bold bg-transparent outline-none mb-4 text-slate-900 dark:text-slate-100"
          />
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
};

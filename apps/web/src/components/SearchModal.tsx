import React, { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { SearchHit } from '@yunshu/shared';
import { api } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

const FILTER_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '笔记' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'docx', label: 'Word' },
  { key: 'xlsx', label: 'Excel' },
];

export const SearchModal: React.FC = () => {
  const searchOpen = useAppStore((s) => s.searchOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const selectNode = useAppStore((s) => s.selectNode);

  const [queryText, setQueryText] = useState('');
  const [filter, setFilter] = useState('all');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(async () => {
      if (!queryText.trim()) {
        setHits([]);
        return;
      }
      setLoading(true);
      try {
        const res = await api.search(queryText, filter === 'all' ? undefined : [filter]);
        setHits(res.hits);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [queryText, filter, searchOpen]);

  if (!searchOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center pt-[12vh] px-4"
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            autoFocus
            type="text"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="搜索笔记标题、正文、Markdown 或 Word/Excel 内部文本..."
            className="flex-1 text-sm bg-transparent outline-none text-slate-900 dark:text-slate-100"
          />
          <button type="button" onClick={() => setSearchOpen(false)} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 flex items-center gap-1.5 border-b border-slate-100 dark:border-slate-800">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setFilter(opt.key)}
              className={`px-2.5 py-0.5 text-xs rounded-full ${
                filter === opt.key
                  ? 'bg-blue-600 text-white font-medium'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-2">
          {loading ? (
            <div className="py-8 text-center text-xs text-slate-400">正在搜索...</div>
          ) : hits.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {queryText.trim() ? '未找到匹配结果' : '输入关键词即可跨笔记与 Office 文档全文检索'}
            </div>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  selectNode(hit.id);
                  setSearchOpen(false);
                }}
                className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {hit.title}
                  </span>
                  <span className="text-[11px] uppercase px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500">
                    {hit.nodeType}
                  </span>
                </div>
                {hit.breadcrumb.length > 0 && (
                  <div className="text-[11px] text-slate-400 mt-0.5">{hit.breadcrumb.join(' / ')}</div>
                )}
                {hit.snippet && (
                  <div className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">
                    {hit.snippet}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

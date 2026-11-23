import React, { useState } from 'react';
import { api } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

export const AuthScreen: React.FC = () => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const setUser = useAppStore((s) => s.setUser);
  const loadTree = useAppStore((s) => s.loadTree);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password, displayName || undefined);
      setUser(res.user, res.token);
      await loadTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请检查服务端是否已启动');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 shadow-sm">
        <div className="mb-6">
          <div className="text-xs font-semibold text-blue-600 mb-1">云树笔记 · 跨端无限层级知识库</div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            {mode === 'login' ? '登录你的笔记空间' : '创建新账号'}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            无需区分笔记本，一棵目录树统一管理笔记、Markdown 与 Office 文档
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 text-sm rounded-md bg-red-50 text-red-700 border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                昵称（可选）
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例如：张三"
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              邮箱地址
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              密码
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位密码"
              className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 text-sm font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
          >
            {loading ? '处理中...' : mode === 'login' ? '立即登录' : '注册并进入'}
          </button>
        </form>

        <div className="mt-5 text-center text-sm text-slate-500">
          {mode === 'login' ? (
            <>
              还没有账号？{' '}
              <button
                type="button"
                onClick={() => setMode('register')}
                className="text-blue-600 font-medium hover:underline"
              >
                立即注册
              </button>
            </>
          ) : (
            <>
              已有账号？{' '}
              <button
                type="button"
                onClick={() => setMode('login')}
                className="text-blue-600 font-medium hover:underline"
              >
                返回登录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import {
  api,
  getApiBase,
  isTauriRuntime,
  normalizeApiBase,
  setApiBase,
  testApiBase,
} from '../lib/api';
import { useAppStore } from '../store/useAppStore';

export const AuthScreen: React.FC = () => {
  const tauriRuntime = isTauriRuntime();
  const [serverUrl, setServerUrl] = useState(() => getApiBase());
  const [serverStatus, setServerStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const setUser = useAppStore((s) => s.setUser);
  const loadTree = useAppStore((s) => s.loadTree);

  const handleTestServer = async () => {
    setError('');
    setServerStatus('');
    try {
      setTesting(true);
      const info = await testApiBase(serverUrl);
      setServerStatus(`连接成功：${info.service ?? 'yunshu-server'}`);
    } catch (err) {
      setServerStatus(err instanceof Error ? err.message : '连接失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // 桌面/手机客户端必须先填写服务端地址；Web 部署模式默认同源
    if (tauriRuntime) {
      try {
        const normalized = normalizeApiBase(serverUrl);
        if (!normalized) {
          setError('请填写服务端地址');
          return;
        }
        setApiBase(normalized);
        setServerUrl(normalized);
      } catch (err) {
        setError(err instanceof Error ? err.message : '服务器地址格式不正确');
        return;
      }
    }

    setLoading(true);
    try {
      const res = await api.login(email, password);
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
          <img src="/logo-192.png" alt="云树笔记" className="w-12 h-12 rounded-xl mb-3 shadow-sm" />
          <div className="text-xs font-semibold text-blue-600 mb-1">云树笔记 · 跨端无限层级知识库</div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">登录你的笔记空间</h1>
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
          {tauriRuntime && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40 p-3">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  服务端地址
                </label>
                <button
                  type="button"
                  onClick={handleTestServer}
                  disabled={testing || !serverUrl.trim()}
                  className="text-xs text-blue-600 font-medium hover:underline disabled:opacity-50"
                >
                  {testing ? '连接中...' : '测试连接'}
                </button>
              </div>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setServerStatus('');
                }}
                placeholder="https://your-server.example.com"
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 font-mono"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                填写服务端地址（需以 http:// 或 https:// 开头）；手机端建议使用 https:// 域名地址。
              </p>
              {serverStatus && (
                <p
                  className={`mt-1 text-[11px] ${
                    serverStatus.startsWith('连接成功') ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {serverStatus}
                </p>
              )}
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
            {loading ? '处理中...' : '立即登录'}
          </button>
        </form>

        <div className="mt-5 text-center text-xs text-slate-400">账号由管理员统一开通</div>
      </div>
    </div>
  );
};

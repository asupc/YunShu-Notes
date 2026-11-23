import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { config } from '../config';
import { db } from '../db';

export function startHocuspocusServer(verifyToken: (token: string) => { userId: string } | null): void {
  const server = Server.configure({
    port: config.wsPort,
    debounce: 2000,
    maxDebounce: 8000,
    async onAuthenticate(data) {
      const payload = verifyToken(data.token);
      if (!payload) throw new Error('WebSocket 鉴权失败');
      const nodeId = data.documentName.replace(/^node:/, '');
      const check = db
        .prepare('SELECT id FROM nodes WHERE id = ? AND user_id = ?')
        .get(nodeId, payload.userId);
      if (!check) throw new Error('无权访问该笔记节点');
      return { user: payload };
    },
    async onLoadDocument(data) {
      const nodeId = data.documentName.replace(/^node:/, '');
      const row = db
        .prepare('SELECT yjs_state FROM nodes WHERE id = ?')
        .get(nodeId) as { yjs_state: Buffer | null } | undefined;
      if (row?.yjs_state && row.yjs_state.length > 0) {
        Y.applyUpdate(data.document, new Uint8Array(row.yjs_state));
      }
      return data.document;
    },
    async onStoreDocument(data) {
      const nodeId = data.documentName.replace(/^node:/, '');
      const state = Buffer.from(Y.encodeStateAsUpdate(data.document));
      db.prepare("UPDATE nodes SET yjs_state = ?, updated_at = datetime('now') WHERE id = ?").run(
        state,
        nodeId
      );
    },
  });

  void server.listen();
  console.log(`[云树协同] Hocuspocus Yjs WebSocket 服务已监听端口 ${config.wsPort}`);
}

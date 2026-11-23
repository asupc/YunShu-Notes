import 'dotenv/config';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  wsPort: Number(process.env.WS_PORT ?? 3002),
  publicApiBase: (process.env.PUBLIC_API_BASE ?? 'http://127.0.0.1:3001').replace(/\/$/, ''),
  dataDir,
  sqlitePath: path.resolve(process.env.SQLITE_PATH ?? path.join(dataDir, 'yunshu.db')),
  filesDir: path.join(dataDir, 'files'),
  previewsDir: path.join(dataDir, 'previews'),
  jwtSecret: process.env.JWT_SECRET ?? 'yunshu-dev-jwt-secret-change-me',
};
